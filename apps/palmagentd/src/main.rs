#[cfg(target_os = "linux")]
mod contract;
#[cfg(target_os = "linux")]
mod daemon;
#[cfg(target_os = "linux")]
mod hosts;
#[cfg(target_os = "linux")]
mod platform;
#[cfg(target_os = "linux")]
use platform::storage;

#[cfg(target_os = "linux")]
fn run() -> anyhow::Result<()> {
    use anyhow::{Context, ensure};
    use contract::{Kind, PROTOCOL, Request, SOURCE_COMMIT, VERSION};
    use platform::{Autostart, NativePlatform, ProcessControl};
    use serde_json::json;
    use std::{io::Read, path::PathBuf};
    let args: Vec<String> = std::env::args().skip(1).collect();
    let action = args.first().map(String::as_str).unwrap_or("help");
    if action == "version" || action == "--version" {
        println!(
            "{}",
            json!({ "version": VERSION, "sourceCommit": SOURCE_COMMIT, "protocol": PROTOCOL })
        );
        return Ok(());
    }
    if action == "help" || action == "--help" {
        println!(
            "palmagentd <serve|start-current|request|bootstrap-unit|version> --data-dir <directory>"
        );
        return Ok(());
    }
    fn flag<'a>(args: &'a [String], name: &str) -> anyhow::Result<&'a str> {
        args.windows(2)
            .find(|pair| pair[0] == name)
            .map(|pair| pair[1].as_str())
            .with_context(|| format!("Missing {name}"))
    }
    let data = PathBuf::from(flag(&args, "--data-dir")?).canonicalize()?;
    storage::private_directory(&data)?;
    match action {
        "serve" => daemon::serve(&data),
        "start-current" => {
            let config = storage::configuration(&data)?;
            NativePlatform::replace(&config.daemon, &data)
        }
        "request" => {
            let mut input = String::new();
            std::io::stdin().take(65_537).read_to_string(&mut input)?;
            ensure!(input.len() <= 65_536, "Request is too large");
            let request: Request = serde_json::from_str(&input)?;
            println!("{}", daemon::request(&data, &request)?);
            Ok(())
        }
        "host" => {
            let kind: Kind = serde_json::from_value(json!(flag(&args, "--kind")?))?;
            hosts::run(&data, kind, flag(&args, "--id")?)
        }
        "bootstrap-unit" => {
            let launcher = PathBuf::from(flag(&args, "--launcher")?);
            print!(
                "{}",
                NativePlatform::render(
                    &data,
                    &launcher,
                    flag(&args, "--user")?,
                    flag(&args, "--group")?
                )?
            );
            Ok(())
        }
        _ => anyhow::bail!("Unknown daemon command"),
    }
}

#[cfg(target_os = "linux")]
fn main() {
    if let Err(error) = run() {
        eprintln!("palmagentd: {error:#}");
        std::process::exit(1);
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("This build does not include an adapter for this operating system");
    std::process::exit(1);
}
