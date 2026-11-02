//! Test driver only: JSON lines over stdin/stdout. Production hosts call Controller directly.
use serde_json::{json, Value};
use swiftnest_perch::runtime::Controller;
use tokio::io::{AsyncBufReadExt, BufReader};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = std::env::args_os().nth(1).expect("data directory");
    let core = Controller::open(dir)?;
    // Test harness observes snapshots; the production App requires a working tray.
    core.set_indicator_ready(true);
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut timer = tokio::time::interval(std::time::Duration::from_millis(50));
    let mut last = String::new();
    loop {
        tokio::select! {
            _ = timer.tick() => {
                let snapshot = serde_json::to_string(&core.snapshot())?;
                if snapshot != last { println!("{snapshot}"); last = snapshot; }
            },
            line = lines.next_line() => {
                let Some(line) = line? else { break; };
                let value: Value = serde_json::from_str(&line)?;
                let result = match value["op"].as_str() {
                    Some("start") => core.configure(serde_json::from_value(value["settings"].clone())?, value["code"].as_str().map(str::to_string)).await,
                    Some("confirm") => core.confirm(value["accept"] == true),
                    Some("unpair") => core.unpair().await,
                    Some("stop-view") => core.stop_view(),
                    Some("disable") => core.disable().await,
                    Some("quit") => break,
                    _ => continue,
                };
                if let Err(e) = result { println!("{}", json!({"driverError":e})); }
            },
        }
    }
    core.shutdown().await;
    Ok(())
}
