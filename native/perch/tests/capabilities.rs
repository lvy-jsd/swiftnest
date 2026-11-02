use serde_json::json;
use std::{fs, path::PathBuf};
use swiftnest_perch::{
    capability::{Capability, InvokeContext, Risk},
    files::Files,
    paths::PathGuard,
    shell::{classify_command, tokenize, Shell, READ_ONLY},
    store::Store,
};
use tokio_util::sync::CancellationToken;
fn ctx() -> InvokeContext {
    InvokeContext {
        task_id: "t".into(),
        cancel: CancellationToken::new(),
    }
}
fn setup() -> (tempfile::TempDir, PathBuf, PathBuf, Files) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("shared");
    let outside = temp.path().join("outside");
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::create_dir_all(root.join("keys")).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(root.join("a.txt"), "hello").unwrap();
    fs::write(outside.join("secret.txt"), "nope").unwrap();
    fs::write(root.join("keys/id"), "private").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
    let cap = Files {
        guard: PathGuard::new(vec![root.clone()], vec![root.join("keys")]),
    };
    (temp, root, outside, cap)
}
#[tokio::test]
async fn files_operations_and_limits() {
    let (_temp, root, _, cap) = setup();
    assert!(cap
        .invoke("list", json!({"path":"."}), ctx())
        .await
        .unwrap()
        .text
        .contains("a.txt"));
    let out = cap
        .invoke("read", json!({"path":"a.txt"}), ctx())
        .await
        .unwrap();
    assert_eq!(out.text, "hello");
    assert!(out.untrusted);
    for (content, append) in [("x", false), ("y", true)] {
        cap.invoke(
            "write",
            json!({"path":"sub/new.txt","content":content,"append":append}),
            ctx(),
        )
        .await
        .unwrap();
    }
    assert_eq!(fs::read_to_string(root.join("sub/new.txt")).unwrap(), "xy");
    cap.invoke(
        "move",
        json!({"from":"sub/new.txt","to":"sub/moved.txt"}),
        ctx(),
    )
    .await
    .unwrap();
    assert_eq!(
        cap.invoke("move", json!({"from":"a.txt","to":"sub/moved.txt"}), ctx())
            .await
            .unwrap_err()
            .code,
        "TARGET_EXISTS"
    );
    assert_eq!(
        cap.invoke("delete", json!({"path":"sub"}), ctx())
            .await
            .unwrap_err()
            .code,
        "IS_A_FOLDER"
    );
    cap.invoke("delete", json!({"path":"sub","recursive":true}), ctx())
        .await
        .unwrap();
    assert!(cap
        .invoke("stat", json!({"path":"sub"}), ctx())
        .await
        .is_err());
    assert_eq!(
        cap.invoke("delete", json!({"path":root,"recursive":true}), ctx())
            .await
            .unwrap_err()
            .code,
        "PATH_REFUSED"
    );
    cap.invoke("mkdir", json!({"path":"new/deep"}), ctx())
        .await
        .unwrap();
    fs::write(root.join("big"), vec![b'a'; 600 * 1024]).unwrap();
    assert!(cap
        .invoke("read", json!({"path":"big"}), ctx())
        .await
        .unwrap()
        .text
        .ends_with("[truncated: showing 524288 of 614400 bytes]"));
    fs::write(root.join("binary"), [0, 1, 2]).unwrap();
    assert_eq!(
        cap.invoke("read", json!({"path":"binary"}), ctx())
            .await
            .unwrap()
            .data
            .unwrap()["binary"],
        true
    );
    for i in 0..510 {
        fs::write(root.join(format!("f{i}")), "").unwrap();
    }
    let out = cap
        .invoke("list", json!({"path":"."}), ctx())
        .await
        .unwrap()
        .data
        .unwrap();
    assert_eq!(out["entries"].as_array().unwrap().len(), 500);
    assert!(out["total"].as_u64().unwrap() > 500);
}
#[tokio::test]
async fn files_guards_and_risk_cases() {
    let (_temp, root, outside, cap) = setup();
    for path in [
        outside.join("secret.txt"),
        PathBuf::from("../outside/secret.txt"),
    ] {
        assert_eq!(
            cap.invoke("read", json!({"path":path}), ctx())
                .await
                .unwrap_err()
                .code,
            "PATH_NOT_ALLOWED"
        );
    }
    #[cfg(unix)]
    {
        for (tool, path) in [
            ("read", "escape/secret.txt"),
            ("write", "escape/planted.txt"),
        ] {
            assert_eq!(
                cap.invoke(tool, json!({"path":path,"content":"x"}), ctx())
                    .await
                    .unwrap_err()
                    .code,
                "PATH_NOT_ALLOWED"
            );
        }
        std::os::unix::fs::symlink(root.join("keys"), root.join("hidden")).unwrap();
        assert_eq!(
            cap.invoke("read", json!({"path":"hidden/id"}), ctx())
                .await
                .unwrap_err()
                .code,
            "PATH_REFUSED"
        );
        std::os::unix::fs::symlink(outside.join("missing"), root.join("dangling")).unwrap();
        assert_eq!(
            cap.invoke("write", json!({"path":"dangling","content":"x"}), ctx())
                .await
                .unwrap_err()
                .code,
            "PATH_REFUSED"
        );
    }
    assert_eq!(
        cap.invoke("read", json!({"path":"keys/id"}), ctx())
            .await
            .unwrap_err()
            .code,
        "PATH_REFUSED"
    );
    for (tool, args, risk) in [
        ("read", json!({"path":"a.txt"}), Risk::Read),
        ("write", json!({"path":"a.txt"}), Risk::Write),
        ("delete", json!({"path":"a.txt"}), Risk::Sensitive),
        ("read", json!({"path":outside.join("x")}), Risk::Sensitive),
        (
            "move",
            json!({"from":"a.txt","to":outside.join("x")}),
            Risk::Sensitive,
        ),
        ("read", json!({"path":"~/.ssh/id_ed25519"}), Risk::Sensitive),
    ] {
        assert_eq!(cap.classify(tool, &args).risk, risk);
    }
    let c = ctx();
    c.cancel.cancel();
    assert_eq!(
        cap.invoke("write", json!({"path":"cancelled","content":"x"}), c)
            .await
            .unwrap_err()
            .code,
        "CANCELLED"
    );
    assert!(!root.join("cancelled").exists());
    assert!(Files {
        guard: PathGuard::new(vec![], vec![])
    }
    .invoke("read", json!({"path":root.join("a.txt")}), ctx())
    .await
    .is_err());
}
#[test]
fn shell_classification_and_tokenizer_cases() {
    let home = dirs::home_dir().unwrap();
    let guard = PathGuard::new(vec![home], vec![]);
    // Shared with cap-shell's TypeScript tests, so both classifiers stay in step.
    let cases: Vec<(String, Risk)> = serde_json::from_str(include_str!(
        "../../../plugins/cap-shell/test/classification-cases.json"
    ))
    .unwrap();
    for (command, risk) in cases {
        assert_eq!(
            classify_command(&command, &READ_ONLY, &guard).risk,
            risk,
            "{command}"
        );
    }
    assert_eq!(
        classify_command("git status", &["git"], &guard).risk,
        Risk::Read
    );
    assert_eq!(
        tokenize("grep -n \"a b\" 'c d'").unwrap(),
        vec!["grep", "-n", "a b", "c d"]
    );
    assert_eq!(tokenize("echo \"\"").unwrap(), vec!["echo", ""]);
    assert!(tokenize("echo \"x").is_none());
}
#[tokio::test]
async fn shell_sandbox_output_and_cancellation() {
    let (_temp, root, outside, files) = setup();
    let shell = Shell { guard: files.guard };
    assert_eq!(
        shell
            .invoke("run", json!({"command":"cat keys/id"}), ctx())
            .await
            .unwrap_err()
            .code,
        "PATH_REFUSED"
    );
    assert_eq!(
        shell
            .invoke("run", json!({"command":"cat /etc/passwd"}), ctx())
            .await
            .unwrap_err()
            .code,
        "PATH_NOT_ALLOWED"
    );
    assert_eq!(
        shell
            .invoke("run", json!({"command":"echo ok","cwd":outside}), ctx())
            .await
            .unwrap_err()
            .code,
        "PATH_NOT_ALLOWED"
    );
    #[cfg(target_os = "linux")]
    {
        if std::process::Command::new("bwrap")
            .arg("--version")
            .output()
            .is_err()
        {
            assert_eq!(
                shell
                    .invoke("run", json!({"command":"echo hello"}), ctx())
                    .await
                    .unwrap_err()
                    .code,
                "SANDBOX_UNAVAILABLE"
            );
            return;
        }
        assert_eq!(
            shell
                .invoke("run", json!({"command":"echo hello"}), ctx())
                .await
                .unwrap()
                .text,
            "hello"
        );
        let out = shell
            .invoke(
                "run",
                json!({"command":"ls a-folder-that-does-not-exist"}),
                ctx(),
            )
            .await
            .unwrap();
        assert!(out.text.contains("[exit code "));
        assert!(out.text.contains("[stderr]"));
        let out = shell
            .invoke(
                "run",
                json!({"command":"definitely-not-a-program-xyz"}),
                ctx(),
            )
            .await
            .unwrap();
        assert!(out.text.contains("127"));
        let out = shell
            .invoke("run", json!({"command":"yes x | head -c 100000"}), ctx())
            .await
            .unwrap();
        assert!(out.data.unwrap()["truncated"].as_bool().unwrap());
        // Approved exec still cannot bypass the shared-folder fence through a shell substitution.
        let out = shell.invoke("run",json!({"command":format!("cat '{}' > stolen",outside.join("secret.txt").display())}),ctx()).await.unwrap_err();
        assert_eq!(out.code, "PATH_NOT_ALLOWED");
        shell
            .invoke(
                "run",
                json!({"command":"sh -c 'cat keys/id > stolen'"}),
                ctx(),
            )
            .await
            .unwrap();
        assert_ne!(
            fs::read_to_string(root.join("stolen")).unwrap_or_default(),
            "private"
        );
        // Read classification cannot grant writes through program-specific flags (e.g. sort -o).
        shell
            .invoke("run", json!({"command":"sort -o sneaky a.txt"}), ctx())
            .await
            .unwrap();
        assert!(!root.join("sneaky").exists());
        let c = ctx();
        let cancel = c.cancel.clone();
        let work = shell.invoke("run", json!({"command":"sleep 2; echo late > late"}), c);
        tokio::pin!(work);
        tokio::select! { _ = &mut work => panic!("should still run"), _ = tokio::time::sleep(std::time::Duration::from_millis(150)) => {} }
        cancel.cancel();
        assert_eq!(work.await.unwrap_err().code, "CANCELLED");
        tokio::time::sleep(std::time::Duration::from_millis(2200)).await;
        assert!(!root.join("late").exists());
    }
}
#[test]
fn persistence_and_private_permissions() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join("data");
    let mut a = Store::open(&dir).unwrap();
    let key = a.identity.to_bytes();
    let slug = a.settings.slug.clone();
    a.settings.name = "My laptop".into();
    a.settings.nest_key = Some("pinned".into());
    a.save().unwrap();
    let b = Store::open(&dir).unwrap();
    assert_eq!(b.identity.to_bytes(), key);
    assert_eq!(b.settings.slug, slug);
    assert_eq!(b.settings.name, "My laptop");
    assert_eq!(b.settings.nest_key.as_deref(), Some("pinned"));
    assert!(!b.settings.enabled);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(dir.join("identity.key"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}

#[tokio::test]
async fn controller_permissions_and_trust_are_host_owned() {
    use swiftnest_perch::runtime::Controller;
    let temp = tempfile::tempdir().unwrap();
    let core = Controller::open(temp.path().join("state")).unwrap();
    let initial = core.snapshot();
    assert!(!initial.settings.enabled);
    assert!(initial.settings.roots.is_empty());
    let mut forged = initial.settings.clone();
    forged.slug = "imposter".into();
    forged.nest_key = Some("imposter".into());
    core.configure(forged, None).await.unwrap();
    assert_eq!(core.snapshot().settings.slug, initial.settings.slug);
    assert!(core.snapshot().settings.nest_key.is_none());
    let mut invalid = core.snapshot().settings;
    invalid.enabled = true;
    invalid.url = "ws://localhost:7711/swiftnest".into();
    assert_eq!(
        core.configure(invalid, None).await.unwrap_err().code,
        "BAD_ARGS"
    );
    assert!(!core.snapshot().settings.enabled);
    assert_eq!(core.confirm(true).unwrap_err().code, "PAIRING_CLOSED");
    core.unpair().await.unwrap();
    assert_eq!(core.snapshot().settings.slug, initial.settings.slug);
    assert!(!core.snapshot().settings.enabled);
}
