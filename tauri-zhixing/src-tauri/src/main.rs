// 知行 · Tauri 2 后端 —— 对应 Electron 版 main.js 的 IPC 逻辑
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use rand::rngs::OsRng;
use rand::RngCore;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

// ---------------------------------------------------------------------------
// 加密运行态
// ---------------------------------------------------------------------------
struct CryptoState {
    enabled: bool,
    unlocked: bool,
    key: Option<Vec<u8>>,
    salt: Option<String>,
    verifier: Option<String>,
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------
fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().expect("no app_data_dir");
    let _ = fs::create_dir_all(&dir);
    dir
}
fn path_of(app: &AppHandle, name: &str) -> PathBuf {
    data_dir(app).join(name)
}
fn backups_dir(app: &AppHandle) -> PathBuf {
    let d = data_dir(app).join("backups");
    let _ = fs::create_dir_all(&d);
    d
}

// ---------------------------------------------------------------------------
// 加密工具（scrypt + AES-256-GCM，格式 ENC1:iv:tag:data）
// ---------------------------------------------------------------------------
fn derive_key(passphrase: &str, salt_hex: &str) -> [u8; 32] {
    let salt = hex::decode(salt_hex).unwrap_or_default();
    let params = scrypt::Params::new(14, 8, 1, 32).expect("scrypt params");
    let mut out = [0u8; 32];
    scrypt::scrypt(passphrase.as_bytes(), &salt, &params, &mut out).expect("scrypt");
    out
}
fn encrypt_string(plain: &str, key: &[u8]) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let mut iv = [0u8; 12];
    OsRng.fill_bytes(&mut iv);
    let ct = cipher
        .encrypt(Nonce::from_slice(&iv), plain.as_bytes())
        .map_err(|e| e.to_string())?;
    let n = ct.len();
    let (data, tag) = ct.split_at(n - 16);
    Ok(format!(
        "ENC1:{}:{}:{}",
        hex::encode(iv),
        hex::encode(tag),
        hex::encode(data)
    ))
}
fn decrypt_string(payload: &str, key: &[u8]) -> Result<String, String> {
    let parts: Vec<&str> = payload.split(':').collect();
    if parts.len() != 4 || parts[0] != "ENC1" {
        return Err("密文格式错误".into());
    }
    let iv = hex::decode(parts[1]).map_err(|e| e.to_string())?;
    let tag = hex::decode(parts[2]).map_err(|e| e.to_string())?;
    let data = hex::decode(parts[3]).map_err(|e| e.to_string())?;
    let mut ct = data.clone();
    ct.extend_from_slice(&tag);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let pt = cipher
        .decrypt(Nonce::from_slice(&iv), ct.as_ref())
        .map_err(|_| "解密失败".to_string())?;
    String::from_utf8(pt).map_err(|e| e.to_string())
}
fn is_encrypted(s: &str) -> bool {
    s.starts_with("ENC1:")
}

// ---------------------------------------------------------------------------
// JSON 读写（支持加密）
// ---------------------------------------------------------------------------
fn read_json(app: &AppHandle, name: &str, fallback: Value, enc: bool, st: &CryptoState) -> Value {
    let p = path_of(app, name);
    let raw = match fs::read_to_string(&p) {
        Ok(s) => s,
        Err(_) => return fallback,
    };
    if raw.trim().is_empty() {
        return fallback;
    }
    if enc && is_encrypted(&raw) {
        if !st.unlocked {
            return json!({ "__locked__": true });
        }
        let plain = match st.key.as_ref().and_then(|k| decrypt_string(&raw, k).ok()) {
            Some(s) => s,
            None => return fallback,
        };
        return serde_json::from_str(&plain).unwrap_or(fallback);
    }
    serde_json::from_str(&raw).unwrap_or(fallback)
}

fn write_json(app: &AppHandle, name: &str, val: &Value, enc: bool, st: &CryptoState) -> bool {
    let p = path_of(app, name);
    let mut content = serde_json::to_string_pretty(val).unwrap_or_default();
    if enc && st.unlocked {
        if let Some(k) = st.key.as_ref() {
            if let Ok(e) = encrypt_string(&content, k) {
                content = e;
            }
        }
    }
    let tmp = p.with_extension("tmp");
    if fs::write(&tmp, &content).is_err() {
        return false;
    }
    fs::rename(&tmp, &p).is_ok()
}

// ---------------------------------------------------------------------------
// 备份
// ---------------------------------------------------------------------------
fn today_str() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}
fn maybe_daily_backup(app: &AppHandle, todos: &Value, enc: bool, st: &CryptoState) {
    let day = today_str();
    let dir = backups_dir(app);
    let file = dir.join(format!("todo-backup-{}.json", day));
    let mut content = serde_json::to_string_pretty(todos).unwrap_or_default();
    if enc && st.unlocked {
        if let Some(k) = st.key.as_ref() {
            if let Ok(e) = encrypt_string(&content, k) {
                content = e;
            }
        }
    }
    let _ = fs::write(&file, &content);
    // 保留最近 7 天
    if let Ok(rd) = fs::read_dir(&dir) {
        let mut files: Vec<PathBuf> = rd
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.starts_with("todo-backup-") && s.ends_with(".json"))
                    .unwrap_or(false)
            })
            .collect();
        files.sort();
        while files.len() > 7 {
            let old = files.remove(0);
            let _ = fs::remove_file(old);
        }
    }
}

// ---------------------------------------------------------------------------
// 日报汇总
// ---------------------------------------------------------------------------
fn arr(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
fn s_or<'a>(v: &'a Value, k: &str, d: &'a str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or(d).to_string()
}

/// 完成度：0~100，结办一律 100；容忍 "30%" 这类脏值
fn progress_of(t: &Value) -> i64 {
    if s_or(t, "status", "") == "completed" {
        return 100;
    }
    let raw = t.get("progress").and_then(|v| {
        if let Some(n) = v.as_f64() {
            Some(n)
        } else {
            v.as_str()
                .and_then(|s| s.trim().trim_end_matches('%').parse::<f64>().ok())
        }
    });
    raw.unwrap_or(0.0).round().clamp(0.0, 100.0) as i64
}

fn build_report_summary(todos: &Value, date: &str) -> Value {
    let scope = arr(todos);
    let due: Vec<&Value> = scope
        .iter()
        .filter(|t| s_or(t, "date", "") == date && !t.get("archived").and_then(|x| x.as_bool()).unwrap_or(false))
        .collect();
    let completed: Vec<&Value> = due
        .iter()
        .filter(|t| {
            s_or(t, "status", "") == "completed"
                || s_or(t, "completedAt", "").get(0..10).map(|d| d == date).unwrap_or(false)
        })
        .cloned()
        .collect();
    let in_progress: Vec<&Value> = due.iter().filter(|t| s_or(t, "status", "") == "in-progress").cloned().collect();
    let pending: Vec<&Value> = due.iter().filter(|t| s_or(t, "status", "") == "pending").cloned().collect();
    let overdue: Vec<&Value> = scope
        .iter()
        .filter(|t| {
            !t.get("archived").and_then(|x| x.as_bool()).unwrap_or(false)
                && s_or(t, "status", "") != "completed"
                && {
                    let d = s_or(t, "date", "");
                    !d.is_empty() && d.as_str() < date
                }
        })
        .collect();

    let lines = |a: &Vec<&Value>, label: &str, with_progress: bool| -> String {
        if a.is_empty() {
            return format!("## {}\n（无）\n", label);
        }
        let body = a
            .iter()
            .map(|t| {
                let dt = s_or(t, "dueTime", "");
                let pct = if with_progress && s_or(t, "status", "") == "in-progress" {
                    format!("（完成度 {}%）", progress_of(t))
                } else {
                    String::new()
                };
                if dt.is_empty() {
                    format!("- {}{}", s_or(t, "content", ""), pct)
                } else {
                    format!("- {} {}{}", s_or(t, "content", ""), dt, pct)
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!("## {}\n{}\n", label, body)
    };

    let default_content = format!(
        "# 工作日报（{}）\n\n{}{}{}{}## 明日计划\n- \n",
        date,
        lines(&completed, "今日完成", false),
        lines(&in_progress, "进行中", true),
        lines(&pending, "待处理", false),
        lines(&overdue, "逾期未完成", false)
    );
    let pick = |t: &Value| {
        json!({
            "id": t.get("id").cloned().unwrap_or(Value::Null),
            "content": s_or(t, "content", ""),
            "priority": s_or(t, "priority", ""),
            "listId": s_or(t, "listId", ""),
            "status": s_or(t, "status", ""),
            "date": s_or(t, "date", ""),
            "dueTime": s_or(t, "dueTime", ""),
            "progress": progress_of(t)
        })
    };
    json!({
        "date": date,
        "total": due.len(),
        "counts": {
            "completed": completed.len(),
            "inProgress": in_progress.len(),
            "pending": pending.len(),
            "overdue": overdue.len()
        },
        "items": {
            "completed": completed.iter().map(|t| pick(t)).collect::<Vec<_>>(),
            "inProgress": in_progress.iter().map(|t| pick(t)).collect::<Vec<_>>(),
            "pending": pending.iter().map(|t| pick(t)).collect::<Vec<_>>(),
            "overdue": overdue.iter().map(|t| pick(t)).collect::<Vec<_>>()
        },
        "defaultContent": default_content
    })
}

// ---------------------------------------------------------------------------
// 导入解析 / 导出序列化
// ---------------------------------------------------------------------------
fn csv_escape(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
fn to_csv(todos: &Vec<Value>) -> String {
    let headers = [
        "id", "listId", "startDate", "date", "dueTime", "priority", "content", "note", "status",
        "progress", "tags", "createdAt", "startedAt", "completedAt",
    ];
    let mut out = String::from(headers.join(","));
    out.push('\n');
    for t in todos {
        let tags = t
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("|"))
            .unwrap_or_default();
        let row = vec![
            s_or(t, "id", ""),
            s_or(t, "listId", ""),
            s_or(t, "startDate", ""),
            s_or(t, "date", ""),
            s_or(t, "dueTime", ""),
            s_or(t, "priority", ""),
            csv_escape(&s_or(t, "content", "")),
            csv_escape(&s_or(t, "note", "")),
            s_or(t, "status", ""),
            progress_of(t).to_string(),
            csv_escape(&tags),
            s_or(t, "createdAt", ""),
            s_or(t, "startedAt", ""),
            s_or(t, "completedAt", ""),
        ];
        out.push_str(&row.join(","));
        out.push('\n');
    }
    out
}
fn status_cn(s: &str) -> &str {
    match s {
        "pending" => "待办",
        "in-progress" => "在办",
        "completed" => "结办",
        _ => s,
    }
}
fn pr_cn(s: &str) -> &str {
    match s {
        "high" => "高",
        "medium" => "中",
        "low" => "低",
        _ => s,
    }
}
fn to_txt(todos: &Vec<Value>) -> String {
    let mut out = format!(
        "待办事项列表\n导出时间: {}\n总数量: {}\n{}\n\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M"),
        todos.len(),
        "-".repeat(50)
    );
    for (i, t) in todos.iter().enumerate() {
        let pct = if s_or(t, "status", "") == "in-progress" {
            format!("（完成度 {}%）", progress_of(t))
        } else {
            String::new()
        };
        out.push_str(&format!(
            "{}. [{}] {}{}\n",
            i + 1,
            status_cn(&s_or(t, "status", "")),
            s_or(t, "content", ""),
            pct
        ));
        out.push_str(&format!("   日期: {}{}\n", s_or(t, "date", ""), {
            let dt = s_or(t, "dueTime", "");
            if dt.is_empty() {
                "".to_string()
            } else {
                format!(" {}", dt)
            }
        }));
        out.push_str(&format!("   优先级: {}\n", pr_cn(&s_or(t, "priority", ""))));
        out.push_str(&format!("{}\n", "-".repeat(50)));
    }
    out
}
fn to_markdown(todos: &Vec<Value>) -> String {
    let mut md = format!(
        "# 待办事项列表\n\n> 导出时间：{}　总数：{}\n\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M"),
        todos.len()
    );
    for group in ["pending", "in-progress", "completed"] {
        let items: Vec<&Value> = todos.iter().filter(|t| s_or(t, "status", "") == group).collect();
        if items.is_empty() {
            continue;
        }
        md.push_str(&format!("## {}（{}）\n\n", status_cn(group), items.len()));
        for t in items {
            let box_ = if group == "completed" { "[x]" } else { "[ ]" };
            let mut line = format!("- {} **{}**", box_, s_or(t, "content", ""));
            let mut metas: Vec<String> = vec![];
            if group == "in-progress" {
                metas.push(format!("完成度 {}%", progress_of(t)));
            }
            let date = s_or(t, "date", "");
            if !date.is_empty() {
                let dt = s_or(t, "dueTime", "");
                metas.push(format!("📅 {}{}", date, if dt.is_empty() { "".into() } else { format!(" {}", dt) }));
            }
            let pr = {
                let p = s_or(t, "priority", "");
                pr_cn(&p).to_string()
            };
            if !pr.is_empty() {
                metas.push(format!("🚩 {}", pr));
            }
            if !metas.is_empty() {
                line.push_str(&format!(" — {}", metas.join("　")));
            }
            md.push_str(&line);
            md.push('\n');
        }
        md.push('\n');
    }
    md
}

fn normalize_todo(t: &Value) -> Option<Value> {
    let content = s_or(t, "content", "");
    if content.trim().is_empty() {
        return None;
    }
    let mut tags: Vec<String> = vec![];
    if let Some(ts) = t.get("tags").and_then(|v| v.as_str()) {
        tags = ts.split(|c| c == '|' || c == ',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
    } else if let Some(a) = t.get("tags").and_then(|v| v.as_array()) {
        tags = a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
    }
    let status = {
        let s = s_or(t, "status", "pending");
        if ["pending", "in-progress", "completed"].contains(&s.as_str()) { s } else { "pending".into() }
    };
    let progress = if status == "completed" { 100 } else { progress_of(t) };
    let priority = {
        let p = s_or(t, "priority", "medium");
        if ["high", "medium", "low"].contains(&p.as_str()) { p } else { "medium".into() }
    };
    let now = chrono::Utc::now().to_rfc3339();
    // json! 宏内不能直接写 if let / 语句块，先求值再塞进去
    let id = if let Some(id) = t.get("id").and_then(|v| v.as_str()) {
        id.to_string()
    } else {
        format!("{}{}", chrono::Utc::now().timestamp_millis(), rand::random::<u32>())
    };
    let date = {
        let d = s_or(t, "date", "");
        if d.is_empty() { chrono::Local::now().format("%Y-%m-%d").to_string() } else { d }
    };
    Some(json!({
        "id": id,
        "listId": s_or(t, "listId", "default"),
        "startDate": s_or(t, "startDate", ""),
        "date": date,
        "dueTime": s_or(t, "dueTime", ""),
        "priority": priority,
        "content": content.trim(),
        "note": s_or(t, "note", ""),
        "status": status,
        "progress": progress,
        "tags": tags,
        "subtasks": t.get("subtasks").cloned().unwrap_or(json!([])),
        "pinned": t.get("pinned").and_then(|v|v.as_bool()).unwrap_or(false),
        "createdAt": s_or(t, "createdAt", &now),
        "startedAt": t.get("startedAt").cloned().unwrap_or(Value::Null),
        "completedAt": t.get("completedAt").cloned().unwrap_or(Value::Null),
        "updatedAt": s_or(t, "updatedAt", &now)
    }))
}

fn parse_csv(content: &str) -> Vec<Value> {
    let mut rows: Vec<Vec<String>> = vec![];
    let mut row: Vec<String> = vec![];
    let mut cur = String::new();
    let mut in_q = false;
    let chars: Vec<char> = content.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_q {
            if c == '"' {
                if i + 1 < chars.len() && chars[i + 1] == '"' {
                    cur.push('"');
                    i += 1;
                } else {
                    in_q = false;
                }
            } else {
                cur.push(c);
            }
        } else if c == '"' {
            in_q = true;
        } else if c == ',' {
            row.push(cur.clone());
            cur.clear();
        } else if c == '\n' {
            row.push(cur.clone());
            rows.push(row.clone());
            row.clear();
            cur.clear();
        } else if c == '\r' {
        } else {
            cur.push(c);
        }
        i += 1;
    }
    if !cur.is_empty() || !row.is_empty() {
        row.push(cur.clone());
        rows.push(row);
    }
    if rows.is_empty() {
        return vec![];
    }
    let headers: Vec<String> = rows[0].iter().map(|h| h.trim().to_lowercase()).collect();
    let mut out = vec![];
    for r in rows.iter().skip(1) {
        if r.len() == 1 && r[0].trim().is_empty() {
            continue;
        }
        let mut obj = serde_json::Map::new();
        for (idx, h) in headers.iter().enumerate() {
            let v = r.get(idx).cloned().unwrap_or_default().trim().to_string();
            match h.as_str() {
                "createdat" => { obj.insert("createdAt".into(), json!(v)); }
                "startedat" => { obj.insert("startedAt".into(), json!(v)); }
                "completedat" => { obj.insert("completedAt".into(), json!(v)); }
                "duetime" => { obj.insert("dueTime".into(), json!(v)); }
                "listid" => { obj.insert("listId".into(), json!(v)); }
                "startdate" => { obj.insert("startDate".into(), json!(v)); }
                _ => { obj.insert(h.clone(), json!(v)); }
            }
        }
        out.push(Value::Object(obj));
    }
    out
}
fn parse_txt(content: &str) -> Vec<Value> {
    content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let t = l.trim();
            let t2 = if let Some(pos) = t.find(". ") {
                if t[..pos].chars().all(|c| c.is_ascii_digit()) { t[pos + 2..].to_string() } else { t.to_string() }
            } else { t.to_string() };
            json!({ "content": t2, "date": chrono::Local::now().format("%Y-%m-%d").to_string(), "priority": "medium", "status": "pending" })
        })
        .collect()
}
fn parse_markdown(content: &str) -> Vec<Value> {
    let mut out = vec![];
    for line in content.lines() {
        let l = line.trim_start();
        let rest = if let Some(r) = l.strip_prefix("- [x] ").or_else(|| l.strip_prefix("- [X] ")) {
            Some(("completed", r))
        } else if let Some(r) = l.strip_prefix("- [ ] ") {
            Some(("pending", r))
        } else {
            None
        };
        if let Some((status, r)) = rest {
            let text = r.replace("**", "");
            let text = text.split(" — ").next().unwrap_or("").trim().to_string();
            out.push(json!({ "content": text, "status": status, "date": chrono::Local::now().format("%Y-%m-%d").to_string(), "priority": "medium" }));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 命令：任务
// ---------------------------------------------------------------------------
#[tauri::command]
fn get_todos(app: AppHandle, st: State<'_, Mutex<CryptoState>>) -> Value {
    let g = st.lock().unwrap();
    read_json(&app, "todoList.json", json!([]), g.enabled, &g)
}
#[tauri::command]
fn save_todos(app: AppHandle, st: State<'_, Mutex<CryptoState>>, todos: Value) -> Value {
    let g = st.lock().unwrap();
    if g.enabled && !g.unlocked {
        return json!({"success": false, "error": "数据已锁定，请先解锁"});
    }
    let ok = write_json(&app, "todoList.json", &todos, g.enabled, &g);
    if ok {
        maybe_daily_backup(&app, &todos, g.enabled, &g);
    }
    json!({ "success": ok })
}

// 设置 / 清单 / 筛选（明文）
#[tauri::command]
fn get_settings(app: AppHandle) -> Value {
    read_json(&app, "settings.json", Value::Null, false, &plain_state())
}
#[tauri::command]
fn save_settings(app: AppHandle, settings: Value) -> Value {
    json!({ "success": write_json(&app, "settings.json", &settings, false, &plain_state()) })
}
#[tauri::command]
fn get_lists(app: AppHandle) -> Value {
    read_json(&app, "lists.json", Value::Null, false, &plain_state())
}
#[tauri::command]
fn save_lists(app: AppHandle, lists: Value) -> Value {
    json!({ "success": write_json(&app, "lists.json", &lists, false, &plain_state()) })
}
#[tauri::command]
fn get_filters(app: AppHandle) -> Value {
    read_json(&app, "savedFilters.json", json!([]), false, &plain_state())
}
#[tauri::command]
fn save_filters(app: AppHandle, filters: Value) -> Value {
    json!({ "success": write_json(&app, "savedFilters.json", &filters, false, &plain_state()) })
}
fn plain_state() -> CryptoState {
    CryptoState { enabled: false, unlocked: true, key: None, salt: None, verifier: None }
}

// 日报
#[tauri::command]
fn get_reports(app: AppHandle, st: State<'_, Mutex<CryptoState>>) -> Value {
    let g = st.lock().unwrap();
    read_json(&app, "reports.json", json!([]), g.enabled, &g)
}
#[tauri::command]
fn save_reports(app: AppHandle, st: State<'_, Mutex<CryptoState>>, reports: Value) -> Value {
    let g = st.lock().unwrap();
    if g.enabled && !g.unlocked {
        return json!({"success": false, "error": "数据已锁定"});
    }
    json!({ "success": write_json(&app, "reports.json", &reports, g.enabled, &g) })
}
#[tauri::command]
fn generate_report(app: AppHandle, st: State<'_, Mutex<CryptoState>>, date: String) -> Value {
    let g = st.lock().unwrap();
    let todos = read_json(&app, "todoList.json", json!([]), g.enabled, &g);
    let list = if todos.is_array() { todos } else { json!([]) };
    json!({ "success": true, "summary": build_report_summary(&list, &date) })
}

// ---------------------------------------------------------------------------
// 命令：加密
// ---------------------------------------------------------------------------
#[tauri::command]
fn crypto_status(st: State<'_, Mutex<CryptoState>>) -> Value {
    let g = st.lock().unwrap();
    json!({ "enabled": g.enabled, "unlocked": g.unlocked })
}
#[tauri::command]
fn crypto_enable(
    app: AppHandle,
    st: State<'_, Mutex<CryptoState>>,
    passphrase: String,
) -> Value {
    if passphrase.chars().count() < 4 {
        return json!({"success": false, "error": "口令至少 4 个字符"});
    }
    let mut salt_bytes = [0u8; 16];
    OsRng.fill_bytes(&mut salt_bytes);
    let salt = hex::encode(salt_bytes);
    let key = derive_key(&passphrase, &salt);
    let verifier = match encrypt_string("todo-verifier-ok", &key) {
        Ok(v) => v,
        Err(e) => return json!({"success": false, "error": e}),
    };
    let meta = json!({ "salt": salt, "verifier": verifier });
    let _ = fs::write(path_of(&app, "crypto.meta.json"), serde_json::to_string_pretty(&meta).unwrap());
    let mut g = st.lock().unwrap();
    g.enabled = true;
    g.unlocked = true;
    g.key = Some(key.to_vec());
    g.salt = Some(salt);
    g.verifier = Some(verifier);
    // 重新加密现有任务与日报
    let todos = read_json(&app, "todoList.json", json!([]), false, &plain_state());
    write_json(&app, "todoList.json", &todos, true, &g);
    let reports = read_json(&app, "reports.json", json!([]), false, &plain_state());
    write_json(&app, "reports.json", &reports, true, &g);
    json!({ "success": true })
}
#[tauri::command]
fn crypto_unlock(st: State<'_, Mutex<CryptoState>>, passphrase: String) -> Value {
    let mut g = st.lock().unwrap();
    if !g.enabled {
        return json!({ "success": true });
    }
    let salt = g.salt.clone().unwrap_or_default();
    let key = derive_key(&passphrase, &salt);
    let verifier = g.verifier.clone().unwrap_or_default();
    match decrypt_string(&verifier, &key) {
        Ok(v) if v == "todo-verifier-ok" => {
            g.key = Some(key.to_vec());
            g.unlocked = true;
            json!({ "success": true })
        }
        _ => json!({"success": false, "error": "口令错误"}),
    }
}
#[tauri::command]
fn crypto_disable(
    app: AppHandle,
    st: State<'_, Mutex<CryptoState>>,
    passphrase: String,
) -> Value {
    let mut g = st.lock().unwrap();
    if !g.enabled {
        return json!({ "success": true });
    }
    let salt = g.salt.clone().unwrap_or_default();
    let key = derive_key(&passphrase, &salt);
    let verifier = g.verifier.clone().unwrap_or_default();
    match decrypt_string(&verifier, &key) {
        Ok(v) if v == "todo-verifier-ok" => {}
        _ => return json!({"success": false, "error": "口令错误"}),
    }
    g.key = Some(key.to_vec());
    g.unlocked = true;
    let todos = read_json(&app, "todoList.json", json!([]), true, &g);
    let reports = read_json(&app, "reports.json", json!([]), true, &g);
    g.enabled = false;
    g.key = None;
    g.unlocked = true;
    g.salt = None;
    g.verifier = None;
    write_json(&app, "todoList.json", &todos, false, &plain_state());
    write_json(&app, "reports.json", &reports, false, &plain_state());
    let _ = fs::remove_file(path_of(&app, "crypto.meta.json"));
    json!({ "success": true })
}

// ---------------------------------------------------------------------------
// 命令：通知
// ---------------------------------------------------------------------------
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Value {
    let _ = app
        .notification()
        .builder()
        .title(if title.is_empty() { "待办提醒" } else { &title })
        .body(body)
        .show();
    json!({ "success": true })
}

// ---------------------------------------------------------------------------
// 命令：备份
// ---------------------------------------------------------------------------
#[tauri::command]
fn list_backups(app: AppHandle) -> Value {
    let dir = backups_dir(&app);
    let mut items: Vec<Value> = vec![];
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
            if name.starts_with("todo-backup-") && name.ends_with(".json") {
                let meta = fs::metadata(&p).ok();
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let mtime = meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                items.push(json!({
                    "name": name,
                    "path": p.to_string_lossy().to_string(),
                    "size": size,
                    "mtime": mtime
                }));
            }
        }
    }
    items.sort_by(|a, b| s_or(b, "name", "").cmp(&s_or(a, "name", "")));
    Value::Array(items)
}
#[tauri::command]
fn restore_backup(app: AppHandle, st: State<'_, Mutex<CryptoState>>, path: String) -> Value {
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => return json!({"success": false, "error": e.to_string()}),
    };
    let g = st.lock().unwrap();
    let parsed: Value = if is_encrypted(&raw) {
        if !g.unlocked {
            return json!({"success": false, "error": "该备份已加密，请先解锁"});
        }
        match g.key.as_ref().and_then(|k| decrypt_string(&raw, k).ok()) {
            Some(plain) => match serde_json::from_str(&plain) {
                Ok(v) => v,
                Err(e) => return json!({"success": false, "error": e.to_string()}),
            },
            None => return json!({"success": false, "error": "解密失败"}),
        }
    } else {
        match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return json!({"success": false, "error": e.to_string()}),
        }
    };
    if !parsed.is_array() {
        return json!({"success": false, "error": "备份文件格式错误"});
    }
    let ok = write_json(&app, "todoList.json", &parsed, g.enabled, &g);
    if ok {
        maybe_daily_backup(&app, &parsed, g.enabled, &g);
    }
    json!({ "success": ok, "todos": parsed })
}
#[tauri::command]
fn backup_now(app: AppHandle, st: State<'_, Mutex<CryptoState>>) -> Value {
    let g = st.lock().unwrap();
    let todos = read_json(&app, "todoList.json", json!([]), g.enabled, &g);
    let list = if todos.is_array() { todos } else { json!([]) };
    maybe_daily_backup(&app, &list, g.enabled, &g);
    json!({ "success": true })
}

// ---------------------------------------------------------------------------
// 命令：导入导出（走后端系统对话框）
// ---------------------------------------------------------------------------
fn save_dialog(app: &AppHandle, default_name: &str, ext: &str) -> Option<PathBuf> {
    app.dialog()
        .file()
        .set_file_name(default_name)
        .add_filter(ext.to_uppercase().as_str(), &[ext])
        .add_filter("All Files", &["*"])
        .blocking_save_file()
        .and_then(|fp| fp.into_path().ok())
}

#[tauri::command]
fn export_todos(app: AppHandle, format: String, todos: Value) -> Value {
    let list = arr(&todos);
    if list.is_empty() {
        return json!({"success": false, "error": "没有可导出的任务"});
    }
    let default = format!("todo-export-{}.{}", chrono::Local::now().format("%Y%m%d-%H%M%S"), format);
    let path = match save_dialog(&app, &default, &format) {
        Some(p) => p,
        None => return json!({"success": false, "error": "导出已取消"}),
    };
    let content = match format.as_str() {
        "json" => serde_json::to_string_pretty(&todos).unwrap_or_default(),
        "csv" => to_csv(&list),
        "txt" => to_txt(&list),
        "md" => to_markdown(&list),
        _ => return json!({"success": false, "error": "不支持的格式"}),
    };
    match fs::write(&path, content) {
        Ok(_) => json!({"success": true, "path": path.to_string_lossy().to_string(), "count": list.len()}),
        Err(e) => json!({"success": false, "error": e.to_string()}),
    }
}

#[tauri::command]
fn export_report(app: AppHandle, format: String, report: Value) -> Value {
    let content = s_or(&report, "content", "");
    if content.is_empty() {
        return json!({"success": false, "error": "日报内容为空"});
    }
    let date = s_or(&report, "date", "export");
    let default = format!("日报-{}.{}", date, format);
    let path = match save_dialog(&app, &default, &format) {
        Some(p) => p,
        None => return json!({"success": false, "error": "导出已取消"}),
    };
    let header = format!(
        "# {}\n\n> 日期：{}\n\n",
        s_or(&report, "title", "工作日报"),
        date
    );
    let body = if format == "md" {
        content
    } else {
        let mut out = String::new();
        for line in content.lines() {
            let l = line.trim_start_matches('#').trim_start().replace("**", "");
            out.push_str(&l);
            out.push('\n');
        }
        out
    };
    match fs::write(&path, format!("{}{}", header, body)) {
        Ok(_) => json!({"success": true, "path": path.to_string_lossy().to_string()}),
        Err(e) => json!({"success": false, "error": e.to_string()}),
    }
}

#[tauri::command]
fn parse_import(file_path: String, format: String) -> Value {
    let content = match fs::read_to_string(&file_path) {
        Ok(s) => s,
        Err(e) => return json!({"success": false, "error": e.to_string()}),
    };
    let parsed: Vec<Value> = match format.as_str() {
        "json" => match serde_json::from_str::<Value>(&content) {
            Ok(Value::Array(a)) => a,
            Ok(_) => return json!({"success": false, "error": "导入的数据不是数组格式"}),
            Err(e) => return json!({"success": false, "error": e.to_string()}),
        },
        "csv" => parse_csv(&content),
        "txt" => parse_txt(&content),
        "md" => parse_markdown(&content),
        _ => return json!({"success": false, "error": "不支持的文件格式"}),
    };
    let normalized: Vec<Value> = parsed.iter().filter_map(normalize_todo).collect();
    json!({ "success": true, "todos": normalized })
}

#[tauri::command]
fn pick_open_file(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_file()
        .and_then(|fp| fp.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn open_path(path: String) -> Value {
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd").args(["/C", "start", "", &path]).spawn();
    json!({ "success": true })
}

#[tauri::command]
fn get_app_info(app: AppHandle) -> Value {
    let data = data_dir(&app);
    json!({
        "version": "1.0.0",
        "dataPath": data.join("todoList.json").to_string_lossy().to_string(),
        "userDataPath": data.to_string_lossy().to_string(),
        "backupDir": backups_dir(&app).to_string_lossy().to_string()
    })
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // 初始化加密状态
            let mut cs = plain_state();
            let meta_path = path_of(app.handle(), "crypto.meta.json");
            if let Ok(raw) = fs::read_to_string(&meta_path) {
                if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                    if v.get("salt").and_then(|x| x.as_str()).is_some()
                        && v.get("verifier").and_then(|x| x.as_str()).is_some()
                    {
                        cs.enabled = true;
                        cs.unlocked = false;
                        cs.salt = v.get("salt").and_then(|x| x.as_str()).map(|s| s.to_string());
                        cs.verifier = v.get("verifier").and_then(|x| x.as_str()).map(|s| s.to_string());
                    }
                }
            }
            app.manage(Mutex::new(cs));

            // 全局快捷键：Ctrl/Cmd + Shift + Space 唤起命令面板
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let handle = app.handle().clone();
            let _ = handle.global_shortcut().on_shortcut(
                "CommandOrControl+Shift+Space",
                move |app, _shortcut, _event| {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                    let _ = app.emit("open-command-bar", "quick");
                },
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_todos,
            save_todos,
            get_settings,
            save_settings,
            get_lists,
            save_lists,
            get_filters,
            save_filters,
            get_reports,
            save_reports,
            generate_report,
            crypto_status,
            crypto_enable,
            crypto_unlock,
            crypto_disable,
            notify,
            list_backups,
            restore_backup,
            backup_now,
            export_todos,
            export_report,
            parse_import,
            pick_open_file,
            open_path,
            get_app_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
