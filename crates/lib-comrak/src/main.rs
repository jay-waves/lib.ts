use lib_comrak::{cli, document};

fn main() -> std::process::ExitCode {
    let args = match cli::parse(std::env::args().skip(1)) {
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
                eprintln!(
                    "error: {}\n  --> {}:{}:{}",
                    diagnostic.message,
                    args.input.display(),
                    diagnostic.line,
                    diagnostic.column
                );
            }
            std::process::ExitCode::FAILURE
        }
    }
}
