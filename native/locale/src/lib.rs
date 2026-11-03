//! The Swiftnest message catalog for the desktop and Android hosts: the same files the TypeScript
//! packages use, so every key means one thing everywhere.
use regex::Regex;
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
pub fn text(key: &str) -> String {
    if english() { &*EN } else { &*ZH }
        .get(key)
        .cloned()
        .unwrap_or_else(|| key.into())
}
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
        translated(source).unwrap_or_else(|| text("fallbackError").replace("{0}", code))
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
}
