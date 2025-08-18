from pydantic import BaseModel
from pydantic_ai import RunContext
import subprocess


def ripgrep_search(pattern: str, folder: str = ".") -> str:
    """
    Run ripgrep to search for a pattern inside files.

    Args:
        pattern (str): The search pattern (regex supported).
        path (str): Directory or file path to search. Defaults to current dir.

    Returns:
        str: Search results or error message.
    """
    try:
        result = subprocess.run(
            ["/opt/homebrew/bin/rg", pattern, folder, "--line-number", "--no-heading"],
            capture_output=True,
            text=True,
            check=True
        )
        return result.stdout.strip() if result.stdout else "No matches found."
    except subprocess.CalledProcessError as e:
        return f"Error: {e.stderr.strip()}"
    except Exception as e:
        return f"Unexpected error: {str(e)}"