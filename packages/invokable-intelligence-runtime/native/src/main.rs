use narada_invokable_intelligence_runtime::{preflight, PreflightRequest};
use std::io::{self, Read};
use std::path::PathBuf;

fn main() {
    let mut args = std::env::args().skip(1);
    let mut registry: Option<PathBuf> = None;
    while let Some(arg) = args.next() {
        if arg == "--registry" {
            registry = args.next().map(PathBuf::from);
        } else if let Some(value) = arg.strip_prefix("--registry=") {
            registry = Some(PathBuf::from(value));
        }
    }
    let registry = registry
        .or_else(|| {
            std::env::var("NARADA_INTELLIGENCE_REGISTRY_DB")
                .ok()
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| fail("registry_path_required"));
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .unwrap_or_else(|_| fail("preflight_request_read_failed"));
    let request: PreflightRequest =
        serde_json::from_str(&input).unwrap_or_else(|_| fail("preflight_request_invalid_json"));
    let outcome = preflight(&registry, &request);
    println!(
        "{}",
        serde_json::to_string(&outcome).expect("serialize preflight outcome")
    );
    if !outcome.admitted() {
        std::process::exit(2);
    }
}

fn fail(message: &str) -> ! {
    eprintln!("{message}");
    std::process::exit(64)
}
