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

fn build_report_summary(todos: &Value, date: &str, author: &str, style: &str) -> Value {
    let scope = arr(todos);
    let archived = |t: &Value| t.get("archived").and_then(|x| x.as_bool()).unwrap_or(false);
    let day_of = |s: String| -> String { s.get(0..10).unwrap_or("").to_string() };
    let started_on = |t: &Value| -> String {
        let sd = s_or(t, "startDate", "");
        if !sd.is_empty() { return day_of(sd); }
        let sa = s_or(t, "startedAt", "");
        if !sa.is_empty() { return day_of(sa); }
        day_of(s_or(t, "createdAt", ""))
    };

    // 当天到期 / 当天开始
    let due: Vec<&Value> = scope
        .iter()
        .filter(|t| !archived(t) && (s_or(t, "date", "") == date || s_or(t, "startDate", "") == date))
        .collect();
    // 完成的按完成时间从早到晚排：先完成的写在日报前面的条目
    let done_at = |t: &Value| -> String {
        let c = s_or(t, "completedAt", "");
        if !c.is_empty() {
            return c;
        }
        let u = s_or(t, "updatedAt", "");
        if !u.is_empty() {
            return u;
        }
        format!("{}T23:59", s_or(t, "date", ""))
    };
    let mut completed: Vec<&Value> = scope
        .iter()
        .filter(|t| {
            if archived(t) {
                return false;
            }
            let st = s_or(t, "status", "");
            let done_day = day_of(s_or(t, "completedAt", ""));
            done_day == date || (st == "completed" && (s_or(t, "date", "") == date || s_or(t, "startDate", "") == date))
        })
        .collect();
    // 完成的按完成时间从早到晚排，先完成的写在前面（同刻保持原顺序，sort_by 稳定）
    completed.sort_by(|a, b| done_at(a).cmp(&done_at(b)));
    // 在办：截止日可以在未来，只要当天已经开始就算「今天在干这件事」；
    // 但只有当天进度真的动过（或有改动痕迹）才写进日志，避免常年挂着的任务天天出现
    let progress_days = |t: &Value| -> Vec<String> {
        let mut entries: Vec<(String, i64)> = match t.get("progressLog").and_then(|v| v.as_array()) {
            Some(a) => a
                .iter()
                .filter_map(|e| {
                    let d = day_of(s_or(e, "d", &s_or(e, "date", "")));
                    if d.is_empty() { return None; }
                    let p = e
                        .get("p")
                        .or_else(|| e.get("progress"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    Some((d, p.clamp(0, 100)))
                })
                .collect(),
            None => vec![],
        };
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        let mut days = vec![];
        let mut prev: Option<i64> = None;
        for (d, p) in entries {
            if prev == Some(p) { continue; }
            days.push(d);
            prev = Some(p);
        }
        days
    };
    let mut in_progress: Vec<&Value> = scope
        .iter()
        .filter(|t| {
            if archived(t) || s_or(t, "status", "") != "in-progress" {
                return false;
            }
            let s = started_on(t);
            if !s.is_empty() && s.as_str() > date {
                return false;
            }
            let days = progress_days(t);
            if days.is_empty() {
                return started_on(t) == date || day_of(s_or(t, "updatedAt", &s_or(t, "createdAt", ""))) == date;
            }
            days.iter().any(|d| d == date)
        })
        .collect();
    in_progress.sort_by(|a, b| started_on(a).cmp(&started_on(b)).then_with(|| s_or(a, "date", "").cmp(&s_or(b, "date", ""))));
    // 历史进度：生成过去某天的日志时用那天记下的完成度，而不是今天的值
    let progress_at = |t: &Value| -> i64 {
        let mut entries: Vec<(String, i64)> = match t.get("progressLog").and_then(|v| v.as_array()) {
            Some(a) => a
                .iter()
                .filter_map(|e| {
                    let d = day_of(s_or(e, "d", &s_or(e, "date", "")));
                    if d.is_empty() { return None; }
                    let p = e.get("p").or_else(|| e.get("progress")).and_then(|v| v.as_i64()).unwrap_or(0);
                    Some((d, p.clamp(0, 100)))
                })
                .collect(),
            None => vec![],
        };
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        match entries.iter().rev().find(|(d, _)| d.as_str() <= date) {
            Some((_, p)) => *p,
            None => progress_of(t),
        }
    };
    let in_progress_owned: Vec<Value> = in_progress
        .iter()
        .map(|t| {
            let mut v = (*t).clone();
            if let Value::Object(m) = &mut v {
                m.insert("progress".to_string(), json!(progress_at(t)));
            }
            v
        })
        .collect();
    let in_progress: Vec<&Value> = in_progress_owned.iter().collect();
    let mut pending: Vec<&Value> = due.iter().filter(|t| s_or(t, "status", "") == "pending").cloned().collect();
    pending.sort_by(|a, b| {
        s_or(a, "date", "")
            .cmp(&s_or(b, "date", ""))
            .then_with(|| s_or(a, "dueTime", "").cmp(&s_or(b, "dueTime", "")))
    });
    let overdue: Vec<&Value> = scope
        .iter()
        .filter(|t| {
            !archived(t)
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

    let default_content = if style == "markdown" {
        format!(
            "# 工作日报（{}）\n\n{}{}{}{}## 明日计划\n- \n",
            date,
            lines(&completed, "今日完成", false),
            lines(&in_progress, "进行中", true),
            lines(&pending, "待处理", false),
            lines(&overdue, "逾期未完成", false)
        )
    } else {
        // 纯文本日志：抬头 + 逐条「（N）内容 完成 / 60% 预计YYYYMMDD完成 / 未开始」
        let tail = |t: &Value| -> String {
            let status = s_or(t, "status", "");
            if status == "completed" {
                "完成".to_string()
            } else if status == "in-progress" {
                let pct = progress_of(t);
                let d = s_or(t, "date", "");
                if !d.is_empty() && d.as_str() > date {
                    format!("{}% 预计{}完成", pct, d.replace('-', ""))
                } else {
                    format!("{}%", pct)
                }
            } else {
                "未开始".to_string()
            }
        };
        let plain: Vec<&Value> = completed
            .iter()
            .chain(in_progress.iter())
            .chain(pending.iter())
            .cloned()
            .collect();
        let mut body = if author.is_empty() {
            String::from("工作日志\n")
        } else {
            format!("{} 工作日志\n", author)
        };
        for (i, t) in plain.iter().enumerate() {
            body.push_str(&format!("（{}）{} {}\n", i + 1, s_or(t, "content", ""), tail(t)));
        }
        body
    };
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
        "title": if author.is_empty() { "工作日志".to_string() } else { format!("{} 工作日志", author) },
        "author": author,
        "style": style,
        "total": completed.len() + in_progress.len() + pending.len(),
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
/// ISO 时间 → 本地「YYYY-MM-DD HH:mm」，解析不了就原样返回
fn fmt_moment(v: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(v) {
        Ok(d) => d.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string(),
        Err(_) => v.to_string(),
    }
}

/// CSV 列顺序：前 14 列与导入模板 tools/templates/tasks.csv 一致，导出文件可直接再导入
const CSV_COLUMN_ORDER: [&str; 21] = [
    "content", "date", "startDate", "dueTime", "priority", "status", "progress", "tags", "note",
    "listId", "createdAt", "startedAt", "completedAt", "archived", "id", "repeat", "subtasks",
    "pinned", "order", "updatedAt", "progressLog",
];

fn pick_columns(columns: Option<Vec<String>>) -> Vec<String> {
    match columns {
        Some(v) if !v.is_empty() => {
            let mut out: Vec<String> = CSV_COLUMN_ORDER
                .iter()
                .filter(|k| v.iter().any(|x| x == *k))
                .map(|k| k.to_string())
                .collect();
            if !out.iter().any(|k| k == "content") {
                out.insert(0, "content".into());
            }
            out
        }
        _ => CSV_COLUMN_ORDER.iter().map(|k| k.to_string()).collect(),
    }
}

fn csv_cell(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// 单列取值：统一成「可读 + 可再导入」的字符串
fn csv_value(t: &Value, key: &str) -> String {
    match key {
        "progress" => {
            if s_or(t, "status", "") == "completed" {
                "100".into()
            } else {
                progress_of(t).to_string()
            }
        }
        "tags" => t
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("|"))
            .unwrap_or_default(),
        "archived" | "pinned" => {
            if t.get(key).and_then(|v| v.as_bool()).unwrap_or(false) {
                "true".into()
            } else {
                "false".into()
            }
        }
        "repeat" => match t.get("repeat") {
            Some(r) => {
                let ty = r.get("type").and_then(|v| v.as_str()).unwrap_or("none");
                if ty.is_empty() || ty == "none" {
                    String::new()
                } else {
                    serde_json::to_string(r).unwrap_or_default()
                }
            }
            None => String::new(),
        },
        "subtasks" => match t.get("subtasks").and_then(|v| v.as_array()) {
            Some(a) if !a.is_empty() => serde_json::to_string(a).unwrap_or_default(),
            _ => String::new(),
        },
        "order" => t
            .get("order")
            .and_then(|v| v.as_i64())
            .map(|n| n.to_string())
            .unwrap_or_default(),
        "progressLog" => t
            .get("progressLog")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|e| {
                        let d = s_or(e, "d", &s_or(e, "date", ""));
                        if d.len() != 10 { return None; }
                        let p = e.get("p").or_else(|| e.get("progress")).and_then(|v| v.as_i64()).unwrap_or(0);
                        Some(format!("{}:{}", d, p.clamp(0, 100)))
                    })
                    .collect::<Vec<_>>()
                    .join("|")
            })
            .unwrap_or_default(),
        _ => match t.get(key) {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) | None => String::new(),
            Some(v) => v.to_string(),
        },
    }
}

fn to_csv(todos: &Vec<Value>, cols: &[String]) -> String {
    // BOM 让 Excel 打开中文不乱码；导入解析时会去掉
    let mut out = String::from("\u{feff}");
    out.push_str(&cols.join(","));
    out.push('\n');
    for t in todos {
        let row: Vec<String> = cols.iter().map(|c| csv_cell(&csv_value(t, c))).collect();
        out.push_str(&row.join(","));
        out.push('\n');
    }
    out
}

/// JSON 导出按勾选的列裁剪
fn project_todo(t: &Value, cols: &[String]) -> Value {
    let mut m = serde_json::Map::new();
    for c in cols {
        let v = match c.as_str() {
            "progress" => json!(if s_or(t, "status", "") == "completed" { 100 } else { progress_of(t) }),
            "tags" => t.get("tags").cloned().unwrap_or(json!([])),
            "subtasks" => t.get("subtasks").cloned().unwrap_or(json!([])),
            "archived" | "pinned" => json!(t.get(c).and_then(|v| v.as_bool()).unwrap_or(false)),
            _ => t.get(c).cloned().unwrap_or(Value::Null),
        };
        m.insert(c.clone(), v);
    }
    Value::Object(m)
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
        if let Some(tags) = t.get("tags").and_then(|v| v.as_array()) {
            let ts: Vec<&str> = tags.iter().filter_map(|x| x.as_str()).collect();
            if !ts.is_empty() {
                out.push_str(&format!("   标签: {}\n", ts.join(", ")));
            }
        }
        let note = s_or(t, "note", "");
        if !note.is_empty() {
            out.push_str(&format!("   备注: {}\n", note));
        }
        for (key, label) in [("createdAt", "创建时间"), ("startedAt", "开始时间"), ("completedAt", "完成时间")] {
            let v = s_or(t, key, "");
            if !v.is_empty() {
                out.push_str(&format!("   {}: {}\n", label, fmt_moment(&v)));
            }
        }
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
    // 「true/false/1/0/是/否」都能吃
    let flag = |k: &str| -> bool {
        match t.get(k) {
            Some(Value::Bool(b)) => *b,
            Some(Value::Number(n)) => n.as_i64().map(|x| x != 0).unwrap_or(false),
            Some(Value::String(s)) => matches!(s.trim().to_lowercase().as_str(), "true" | "1" | "yes" | "y" | "是" | "已归档" | "置顶"),
            _ => false,
        }
    };
    // 子任务：数组直接用；字符串按 JSON 或「a|b」拆
    let subtasks: Value = match t.get("subtasks") {
        Some(Value::Array(a)) => {
            let mut out: Vec<Value> = vec![];
            for (i, s) in a.iter().enumerate() {
                let text = s_or(s, "text", "");
                if text.trim().is_empty() {
                    continue;
                }
                let raw_id = s_or(s, "id", "");
                let sid = if raw_id.trim().is_empty() {
                    format!("{}{}{}", chrono::Utc::now().timestamp_millis(), rand::random::<u16>(), i)
                } else {
                    raw_id
                };
                out.push(json!({
                    "id": sid,
                    "text": text.trim(),
                    "done": s.get("done").and_then(|v| v.as_bool()).unwrap_or(false)
                }));
            }
            Value::Array(out)
        }
        Some(Value::String(s)) if !s.trim().is_empty() => {
            if s.trim_start().starts_with('[') {
                serde_json::from_str::<Value>(s).unwrap_or(json!([]))
            } else {
                Value::Array(
                    s.split(|c| c == '|' || c == ';')
                        .map(|x| x.trim())
                        .filter(|x| !x.is_empty())
                        .map(|x| json!({"text": x, "done": false}))
                        .collect(),
                )
            }
        }
        _ => json!([]),
    };
    // 重复周期：支持 JSON / "daily" / "daily:2"
    let repeat: Value = match t.get("repeat") {
        Some(Value::Object(_)) => t.get("repeat").cloned().unwrap(),
        Some(Value::String(s)) if !s.trim().is_empty() => {
            let s = s.trim();
            if s.starts_with('{') {
                serde_json::from_str::<Value>(s).unwrap_or(json!({"type": "none", "interval": 1}))
            } else {
                let mut it = s.splitn(2, |c| c == ':' || c == '/' || c == '|');
                let ty = it.next().unwrap_or("none").trim();
                let style = if ["none", "daily", "weekly", "monthly", "custom"].contains(&ty) { ty } else { "none" };
                let interval = it.next().and_then(|x| x.trim().parse::<i64>().ok()).unwrap_or(1).max(1);
                json!({"type": style, "interval": interval})
            }
        }
        _ => json!({"type": "none", "interval": 1}),
    };
    let order = t.get("order").and_then(|v| v.as_i64()).unwrap_or(0);
    // 进度流水：数组直接用；字符串支持 JSON 或紧凑写法「2026-10-21:20|2026-10-29:80」
    let progress_log: Value = match t.get("progressLog") {
        Some(Value::Array(a)) => {
            let mut out: Vec<Value> = a
                .iter()
                .filter_map(|e| {
                    let d = s_or(e, "d", &s_or(e, "date", ""));
                    let d = d.get(0..10).unwrap_or("").to_string();
                    if d.len() != 10 { return None; }
                    let p = e
                        .get("p")
                        .or_else(|| e.get("progress"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0)
                        .clamp(0, 100);
                    Some(json!({"d": d, "p": p}))
                })
                .collect();
            out.sort_by(|a, b| s_or(a, "d", "").cmp(&s_or(b, "d", "")));
            Value::Array(out)
        }
        Some(Value::String(s)) if !s.trim().is_empty() => {
            let s = s.trim();
            if s.starts_with('[') {
                Value::Array(vec![])
            } else {
                let mut out: Vec<Value> = s
                    .split(|c| c == '|' || c == ';')
                    .filter_map(|pair| {
                        let mut it = pair.splitn(2, |c| c == ':' || c == '：');
                        let d = it.next().unwrap_or("").trim().to_string();
                        if d.len() != 10 { return None; }
                        let p = it.next().and_then(|x| x.trim().parse::<i64>().ok()).unwrap_or(0).clamp(0, 100);
                        Some(json!({"d": d, "p": p}))
                    })
                    .collect();
                out.sort_by(|a, b| s_or(a, "d", "").cmp(&s_or(b, "d", "")));
                Value::Array(out)
            }
        }
        _ => json!([]),
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
        "progressLog": progress_log,
        "tags": tags,
        "subtasks": subtasks,
        "pinned": flag("pinned"),
        "archived": flag("archived"),
        "repeat": repeat,
        "order": order,
        "createdAt": s_or(t, "createdAt", &now),
        "startedAt": t.get("startedAt").cloned().unwrap_or(Value::Null),
        "completedAt": t.get("completedAt").cloned().unwrap_or(Value::Null),
        "updatedAt": s_or(t, "updatedAt", &now)
    }))
}

fn parse_csv(content: &str) -> Vec<Value> {
    // 去掉 Excel 导出带的 BOM，否则首列表头会变成 "\u{feff}content"
    let content = content.trim_start_matches('\u{feff}');
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
    let settings = read_json(&app, "settings.json", Value::Null, false, &plain_state());
    let author = settings
        .get("reportAuthor")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let style = settings
        .get("reportStyle")
        .and_then(|v| v.as_str())
        .filter(|s| *s == "markdown")
        .unwrap_or("plain")
        .to_string();
    json!({ "success": true, "summary": build_report_summary(&list, &date, &author, &style) })
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
fn export_todos(app: AppHandle, format: String, todos: Value, columns: Option<Vec<String>>) -> Value {
    let list = arr(&todos);
    if list.is_empty() {
        return json!({"success": false, "error": "没有可导出的任务"});
    }
    let cols = pick_columns(columns);
    let default = format!("知行-任务-{}.{}", chrono::Local::now().format("%Y%m%d-%H%M%S"), format);
    let path = match save_dialog(&app, &default, &format) {
        Some(p) => p,
        None => return json!({"success": false, "error": "导出已取消"}),
    };
    let content = match format.as_str() {
        "json" => {
            let projected: Vec<Value> = list.iter().map(|t| project_todo(t, &cols)).collect();
            serde_json::to_string_pretty(&projected).unwrap_or_default()
        }
        "csv" => to_csv(&list, &cols),
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
        "version": env!("CARGO_PKG_VERSION"),
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
