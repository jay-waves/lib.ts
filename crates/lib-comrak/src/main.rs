use lib_comrak::{cli, document};

fn main() -> std::process::ExitCode {
    let values: Vec<String> = std::env::args().skip(1).collect();
    let short = values.iter().any(|v| v == "--diagnostic-format=short")
        || values
            .windows(2)
            .any(|v| v == ["--diagnostic-format", "short"]);
    let args = match cli::parse(values) {
        Ok(Some(args)) => args,
        Ok(None) => return std::process::ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {message}");
            return std::process::ExitCode::from(2);
        }
    };
    if args.watch {
        return match lib_comrak::watch::run(&args) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("error: {error}");
                std::process::ExitCode::FAILURE
            }
        };
    }
    match document::compile(&args) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(diagnostics) => {
            for diagnostic in diagnostics {
                if short || args.short {
                    eprintln!(
                        "{}:{}:{}: error: {}",
                        args.input.display(),
                        diagnostic.line,
                        diagnostic.column,
                        diagnostic.message.replace(['\r', '\n'], " ")
                    );
                } else {
                    eprintln!(
                        "error: {}\n  --> {}:{}:{}",
                        diagnostic.message,
                        args.input.display(),
                        diagnostic.line,
                        diagnostic.column
                    );
                }
            }
            std::process::ExitCode::FAILURE
        }
    }
}
