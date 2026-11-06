use crate::i18n::text;
use crate::{
    capability::*,
    paths::{realish, PathGuard},
    Failure, Result,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

const MAX_READ: usize = 512 * 1024;
const MAX_LIST: usize = 500;
#[derive(Clone)]
pub struct Files {
    pub guard: PathGuard,
}
#[async_trait]
impl Capability for Files {
    fn manifest(&self) -> Value {
        let mut value: Value =
            serde_json::from_str(include_str!("manifests/files.json")).expect("manifest fixture");
        value["description"] = json!({"en":format!("Files in the folders this device shares: {:?}.", self.guard.roots), "zh":format!("这台设备共享文件夹中的文件：{:?}。", self.guard.roots)});
        value
    }
    fn classify(&self, tool: &str, args: &Value) -> Classification {
        for key in if tool == "move" {
            vec!["from", "to"]
        } else {
            vec!["path"]
        } {
            if let Some(p) = args[key].as_str().filter(|s| !s.is_empty()) {
                let c = self.guard.lexical(Path::new(p));
                if c.secret || !c.inside {
                    return Classification::new(
                        Risk::Sensitive,
                        text!(
                            "willRefused",
                            c.path.display(),
                            if c.secret {
                                "a protected location"
                            } else {
                                "outside the shared folders"
                            }
                        ),
                    );
                }
            }
        }
        Classification {
            risk: match tool {
                "list" | "read" | "stat" => Risk::Read,
                "write" | "mkdir" | "move" => Risk::Write,
                _ => Risk::Sensitive,
            },
            reason: None,
            reason_text: None,
        }
    }
    async fn invoke(&self, tool: &str, args: Value, context: InvokeContext) -> Result<ToolResult> {
        let this = self.clone();
        let tool = tool.to_string();
        tokio::task::spawn_blocking(move || this.call(&tool, &args, context))
            .await
            .map_err(|e| Failure::new("TOOL_FAILED", e.to_string()))?
    }
}
impl Files {
    fn call(&self, tool: &str, args: &Value, ctx: InvokeContext) -> Result<ToolResult> {
        let cancelled = || {
            if ctx.cancel.is_cancelled() {
                Err(Failure::new("CANCELLED", text!("cancelledRequest")))
            } else {
                Ok(())
            }
        };
        cancelled()?;
        let allowed = |k| self.guard.allowed(Path::new(string_arg(args, k)?));
        match tool {
            "list" => {
                let path = allowed("path")?;
                let mut entries = vec![];
                let mut total = 0;
                for entry in fs::read_dir(&path)? {
                    cancelled()?;
                    let entry = entry?;
                    total += 1;
                    if entries.len() >= MAX_LIST {
                        continue;
                    }
                    let ty = entry.file_type()?;
                    let kind = if ty.is_symlink() {
                        "link"
                    } else if ty.is_dir() {
                        "dir"
                    } else if ty.is_file() {
                        "file"
                    } else {
                        "other"
                    };
                    let mut row = json!({"name":entry.file_name().to_string_lossy(), "type":kind});
                    if ty.is_file() {
                        row["size"] = json!(entry.metadata()?.len());
                    }
                    entries.push(row);
                }
                let mut lines: Vec<_> = entries
                    .iter()
                    .map(|r| {
                        format!(
                            "{} {}\t{}",
                            if r["type"] == "dir" {
                                "d"
                            } else if r["type"] == "link" {
                                "l"
                            } else {
                                "-"
                            },
                            r.get("size").map(|v| v.to_string()).unwrap_or_default(),
                            r["name"].as_str().unwrap_or("")
                        )
                    })
                    .collect();
                if total > MAX_LIST {
                    lines.push(format!("… {} more", total - MAX_LIST));
                }
                Ok(ToolResult::data(
                    if lines.is_empty() {
                        "(empty)".into()
                    } else {
                        lines.join("\n")
                    },
                    json!({"path":path,"entries":entries,"total":total}),
                    true,
                ))
            }
            "read" => {
                let path = allowed("path")?;
                let info = fs::metadata(&path)?;
                if !info.is_file() {
                    return Err(Failure::new("NOT_A_FILE", text!("useFilesListFolders")));
                }
                let mut bytes = vec![];
                fs::File::open(&path)?
                    .take(MAX_READ as u64)
                    .read_to_end(&mut bytes)?;
                if bytes.contains(&0) {
                    return Ok(ToolResult::data(
                        format!("(binary file, {} bytes)", info.len()),
                        json!({"path":path,"size":info.len(),"binary":true}),
                        false,
                    ));
                }
                let mut text = String::from_utf8_lossy(&bytes).into_owned();
                if info.len() > MAX_READ as u64 {
                    text.push_str(&format!(
                        "\n[truncated: showing {MAX_READ} of {} bytes]",
                        info.len()
                    ));
                }
                Ok(ToolResult::data(
                    text,
                    json!({"path":path,"size":info.len()}),
                    true,
                ))
            }
            "stat" => {
                let path = allowed("path")?;
                let m = fs::symlink_metadata(&path)?;
                let kind = if m.is_dir() {
                    "dir"
                } else if m.is_symlink() {
                    "link"
                } else if m.is_file() {
                    "file"
                } else {
                    "other"
                };
                let modified = chrono::DateTime::<chrono::Utc>::from(m.modified()?)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                Ok(ToolResult::data(
                    format!("{kind}, {} bytes, modified {modified}", m.len()),
                    json!({"path":path,"type":kind,"size":m.len(),"modified":modified}),
                    false,
                ))
            }
            "write" => {
                let path = allowed("path")?;
                let content = args["content"]
                    .as_str()
                    .ok_or_else(|| Failure::new("BAD_ARGS", text!("contentMustString")))?;
                fs::create_dir_all(
                    path.parent()
                        .ok_or_else(|| Failure::new("BAD_ARGS", text!("invalidParent")))?,
                )?;
                cancelled()?;
                let append = args["append"].as_bool().unwrap_or(false);
                let mut file = fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .append(append)
                    .truncate(!append)
                    .open(&path)?;
                file.write_all(content.as_bytes())?;
                // Writing a script without the execute bit makes the obvious next
                // step fail with EACCES and costs a second approval, so the mode
                // is applied as part of the same write. Unix only; the field is
                // accepted and ignored elsewhere.
                #[cfg(unix)]
                if let Some(mode) = args["mode"].as_u64() {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&path, fs::Permissions::from_mode(mode as u32))?;
                }
                Ok(ToolResult::text(format!(
                    "{} {} bytes to {}",
                    if append { "appended" } else { "wrote" },
                    content.len(),
                    path.display()
                )))
            }
            "mkdir" => {
                let path = allowed("path")?;
                fs::create_dir_all(&path)?;
                Ok(ToolResult::text(format!("created {}", path.display())))
            }
            "move" => {
                let from = allowed("from")?;
                let to = allowed("to")?;
                if fs::symlink_metadata(&to).is_ok() {
                    return Err(Failure::new(
                        "TARGET_EXISTS",
                        text!("targetExistsChooseAnotherName"),
                    ));
                }
                fs::create_dir_all(
                    to.parent()
                        .ok_or_else(|| Failure::new("BAD_ARGS", text!("invalidParent")))?,
                )?;
                fs::rename(&from, &to)?;
                Ok(ToolResult::text(format!(
                    "moved {} → {}",
                    from.display(),
                    to.display()
                )))
            }
            "delete" => {
                let path = allowed("path")?;
                for root in &self.guard.roots {
                    if realish(root)? == path {
                        return Err(Failure::new(
                            "PATH_REFUSED",
                            text!("refusingDeleteSharedRootFolderItself"),
                        ));
                    }
                }
                if fs::symlink_metadata(&path)?.is_dir() {
                    if args["recursive"] != true {
                        return Err(Failure::new(
                            "IS_A_FOLDER",
                            text!("passRecursiveTrueDeleteFolder"),
                        ));
                    }
                    fs::remove_dir_all(&path)?;
                } else {
                    fs::remove_file(&path)?;
                }
                Ok(ToolResult::text(format!("deleted {}", path.display())))
            }
            _ => Err(Failure::new("UNKNOWN_TOOL", text!("filesNoToolTool", tool))),
        }
    }
}
