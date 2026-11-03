//! The Swiftnest message catalog for the desktop and Android hosts: the same files the TypeScript
//! packages use, so every key means one thing everywhere.
use regex::Regex;
use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicU8, Ordering},
        LazyLock,
    },
};
static LANGUAGE: AtomicU8 = AtomicU8::new(0);
pub const EN_JSON: &str = include_str!("../../../packages/protocol/src/locales/en.json");
pub const ZH_JSON: &str = include_str!("../../../packages/protocol/src/locales/zh-CN.json");
static EN: LazyLock<BTreeMap<String, String>> =
    LazyLock::new(|| serde_json::from_str(EN_JSON).expect("en catalog"));
static ZH: LazyLock<BTreeMap<String, String>> =
    LazyLock::new(|| serde_json::from_str(ZH_JSON).expect("zh catalog"));
struct Entry {
    key: String,
    regex: Regex,
    slots: Vec<String>,
}
static TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{[^{}]*\}").unwrap());
static PATTERNS: LazyLock<Vec<Entry>> = LazyLock::new(|| {
    let token = &*TOKEN;
    let mut entries: Vec<_> = EN
        .iter()
        .map(|(key, value)| {
            let mut pattern = String::from("^");
            let mut offset = 0;
            let mut slots = Vec::new();
            for slot in token.find_iter(value) {
                pattern.push_str(&regex::escape(&value[offset..slot.start()]));
                pattern.push_str("([\\s\\S]*?)");
                slots.push(slot.as_str().to_string());
                offset = slot.end();
            }
            pattern.push_str(&regex::escape(&value[offset..]));
            pattern.push('$');
            Entry {
                key: key.clone(),
                regex: Regex::new(&pattern).unwrap(),
                slots,
            }
        })
        .collect();
    entries.sort_by_key(|entry| (entry.slots.len(), std::cmp::Reverse(EN[&entry.key].len())));
    entries
});
pub fn set_language(lang: &str) {
    LANGUAGE.store(if lang == "en" { 2 } else { 1 }, Ordering::Relaxed);
}
pub fn english() -> bool {
    match LANGUAGE.load(Ordering::Relaxed) {
        2 => true,
        1 => false,
        _ => std::env::var("SWIFTNEST_LANG").as_deref() == Ok("en"),
    }
}
/// True for a key in the catalog.
pub fn known(key: &str) -> bool {
    EN.contains_key(key)
}
/// The catalog entry for `key` in the host language, placeholders left in place.
pub fn message(key: &str) -> String {
    catalog(english())
        .get(key)
        .cloned()
        .unwrap_or_else(|| key.into())
}
fn catalog(english: bool) -> &'static BTreeMap<String, String> {
    if english {
        &EN
    } else {
        &ZH
    }
}

/// Catalog text: a key and its arguments. Sent instead of finished prose, so each reader (the
/// server, the App, this host) renders it in their own language.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Text {
    pub key: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<Arg>,
}
/// An argument of catalog text: a value shown as is, or more catalog text.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Arg {
    Plain(String),
    Text(Text),
}
/// What `text!` accepts as an argument: anything printable, or nested catalog text.
pub trait IntoArg {
    fn into_arg(self) -> Arg;
}
impl<T: std::fmt::Display> IntoArg for T {
    fn into_arg(self) -> Arg {
        Arg::Plain(self.to_string())
    }
}
impl IntoArg for Text {
    fn into_arg(self) -> Arg {
        Arg::Text(self)
    }
}
/// `text!("key", arg, ...)`: catalog text with its arguments.
#[macro_export]
macro_rules! text {
    ($key:literal $(, $arg:expr)* $(,)?) => {
        $crate::Text { key: $key, args: vec![$($crate::IntoArg::into_arg($arg)),*] }
    };
}
impl Text {
    /// The text in the host language.
    pub fn render(&self) -> String {
        self.render_in(english())
    }
    /// The text in English, for logs and readers that do not know the key.
    pub fn english(&self) -> String {
        self.render_in(true)
    }
    fn render_in(&self, english: bool) -> String {
        let args: Vec<String> = self
            .args
            .iter()
            .map(|arg| match arg {
                Arg::Plain(value) => value.clone(),
                Arg::Text(text) => text.render_in(english),
            })
            .collect();
        let entry = catalog(english)
            .get(self.key)
            .map_or(self.key, String::as_str);
        SLOT.replace_all(entry, |slot: &regex::Captures<'_>| {
            slot[1]
                .parse::<usize>()
                .ok()
                .and_then(|n| args.get(n))
                .cloned()
                .unwrap_or_default()
        })
        .into_owned()
    }
}
static SLOT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{(\d+)\}").unwrap());
fn translated(source: &str) -> Option<String> {
    for entry in PATTERNS.iter() {
        if let Some(captures) = entry.regex.captures(source) {
            let mut result = ZH[&entry.key].clone();
            // Replace placeholders in one pass, including repeated positional {} slots.
            let token = &*TOKEN;
            let mut position = 0;
            result = token
                .replace_all(&result, |slot: &regex::Captures<'_>| {
                    let index = if &slot[0] == "{}" || &slot[0] == "{:?}" {
                        let next = entry
                            .slots
                            .iter()
                            .enumerate()
                            .skip(position)
                            .find(|(_, s)| s.as_str() == &slot[0])
                            .map(|(i, _)| i)
                            .unwrap_or(position);
                        position = next + 1;
                        next
                    } else {
                        entry.slots.iter().position(|s| s == &slot[0]).unwrap_or(0)
                    };
                    captures
                        .get(index + 1)
                        .map(|m| m.as_str())
                        .unwrap_or("")
                        .to_string()
                })
                .into_owned();
            return Some(result);
        }
    }
    None
}
pub fn translate(source: &str) -> String {
    if english() {
        source.into()
    } else {
        translated(source).unwrap_or_else(|| source.into())
    }
}
pub fn failure_message(code: &str, source: &str) -> String {
    if english() {
        source.into()
    } else {
        translated(source).unwrap_or_else(|| message("fallbackError").replace("{0}", code))
    }
}
/// Localize owner console output without changing protocol fields or user payloads.
#[macro_export]
macro_rules! owner_println {
    ($($arg:tt)*) => { std::println!("{}", $crate::translate(&format!($($arg)*))) };
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalogs_match() {
        assert_eq!(EN.keys().collect::<Vec<_>>(), ZH.keys().collect::<Vec<_>>());
        for value in ZH.values() {
            assert!(!value.is_empty());
        }
        assert_eq!(
            translated("command is empty.").unwrap(),
            "command 不能为空。"
        );
        assert_eq!(translated("port is required").unwrap(), "必须提供 port");
        assert_eq!(
            translated("Source changed; start a new transfer").unwrap(),
            "来源文件已变化，请重新发起传输"
        );
    }

    #[test]
    fn renders_nested_text_in_either_language() {
        let closed = text!(
            "connectionClosedDuringStepBecause",
            text!("handshakeStep"),
            "reset"
        );
        assert_eq!(
            closed.render_in(true),
            "Connection closed during the handshake: reset."
        );
        assert_eq!(closed.render_in(false), "握手 期间连接已关闭：reset。");
        assert_eq!(
            serde_json::to_value(&closed).unwrap(),
            serde_json::json!({"key": "connectionClosedDuringStepBecause", "args": [{"key": "handshakeStep"}, "reset"]})
        );
    }

    /// Every `text!("key", ...)` and `message("key")` in the Rust sources names a catalog entry
    /// and passes as many arguments as the entry has slots.
    #[test]
    fn rust_sources_use_known_keys_with_matching_arguments() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let call = Regex::new(r#"(text!|message)\(\s*"([A-Za-z0-9_]+)""#).unwrap();
        let mut wrong = vec![];
        for dir in ["native/perch/src", "client/src-tauri/src"] {
            for (file, source) in rust_files(&format!("{root}/{dir}")) {
                for found in call.captures_iter(&source) {
                    let key = &found[2];
                    let start = found.get(0).unwrap().end();
                    let args = argument_count(&source[start..]);
                    let expected = EN.get(key).map(|v| slots(v));
                    if found[1].starts_with("text!") && expected != Some(args)
                        || found[1] == *"message" && expected.is_none()
                    {
                        wrong.push(format!("{file}: {key}"));
                    }
                }
            }
        }
        assert_eq!(wrong, Vec::<String>::new());
    }

    fn slots(entry: &str) -> usize {
        let numbers: std::collections::BTreeSet<_> = SLOT
            .captures_iter(entry)
            .map(|c| c[1].to_string())
            .collect();
        numbers.len()
    }

    /// Arguments after the key, up to the call's closing parenthesis.
    fn argument_count(rest: &str) -> usize {
        let (mut depth, mut count, mut in_string, mut escaped) = (0, 0, false, false);
        for c in rest.chars() {
            if in_string {
                (escaped, in_string) = match (escaped, c) {
                    (true, _) => (false, true),
                    (false, '\\') => (true, true),
                    (false, '"') => (false, false),
                    _ => (false, true),
                };
                continue;
            }
            match c {
                '"' => in_string = true,
                '(' | '[' | '{' => depth += 1,
                ')' | ']' | '}' if depth == 0 => return count,
                ')' | ']' | '}' => depth -= 1,
                ',' if depth == 0 => count += 1,
                _ => {}
            }
        }
        count
    }

    fn rust_files(dir: &str) -> Vec<(String, String)> {
        let mut files = vec![];
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                files.extend(rust_files(path.to_str().unwrap()));
            } else if path.extension().is_some_and(|e| e == "rs") {
                let source = std::fs::read_to_string(&path).unwrap();
                files.push((path.display().to_string(), source));
            }
        }
        files
    }
}
