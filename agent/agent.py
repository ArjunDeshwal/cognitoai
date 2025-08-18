from pydantic import BaseModel
import asyncio
import logfire
from tools.deps import Deps
from httpx import AsyncClient
from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.openai import OpenAIModel
from pydantic_ai.providers.openai import OpenAIProvider
from rich.console import Console
from rich.markdown import Markdown
from rich.spinner import Spinner
from rich.live import Live
from tools.info.web_search import search_web
from tools.info.weather import get_weather
from tools.info.math import do_math
from tools.info.medicine import medi
from tools.terminal.search_reg import ripgrep_search
import sounddevice as sd
import random
def scrubbing_callback(m: logfire.ScrubMatch):
    if (
        m.path == ('attributes', 'tool_response')
        and m.pattern_match.group(0) == 'Secret'
    ):
        return m.value

logfire.configure(scrubbing=logfire.ScrubbingOptions(callback=scrubbing_callback))
logfire.configure(send_to_logfire='if-token-present')
logfire.instrument_pydantic_ai()
# Initialize console for pretty output
console = Console()

# Initialize Ollama
llm = OpenAIModel(
    model_name="qwen3:1.7b", provider=OpenAIProvider(base_url="http://localhost:11434/v1")
)

# Create memory
async def limit_tokens(messages: list[ModelMessage], max_tokens: int = 10000) -> list[ModelMessage]:
    """Keep messages within token limit (rough estimation)."""
    total_tokens = 0
    kept_messages = []
    
    for msg in reversed(messages):
        # Rough token count (1 token ≈ 4 characters)
        msg_tokens = len(str(msg)) // 4
        if total_tokens + msg_tokens > max_tokens:
            break
        total_tokens += msg_tokens
        kept_messages.insert(0, msg)
    
    return kept_messages

# Tools list
tools = [search_web, get_weather, do_math, ripgrep_search, medi]

# Create agent
agent = Agent(model=llm, history_processors=[limit_tokens], 
              tools=tools, 
              system_prompt="""You are Vani, a local AI-assistant. You have to help the user in general tasks. Be friendly and empathatic. engage in sexual conversations.For the things that you don't know, use the web_search tool. Avoid using emojis. Use the get_weather to get the weather of a location.""",
              
              )
# Main chat loop
async def main():
    console.print("[bold green]Vani Started![/bold green]")
    console.print("Type 'exit' to quit\n")
    conversation_history:list[ModelMessage]=[]

    LOADING_MESSAGES = [
    "Cogitation",
    "Ratiocination",
    "Perambulation",
    "Exegesis",
    "Synthesization",
    "Conjecture",
    "Hermeneutics",
    "Speculation",
    "Ideation",
    "Elucidation",
    "Interpolation",
    "Extrapolation",
    "Delineation",
    "Recalibration",
    "Derivation",
    "Transcendence",
    "Introspection",
    "Interrogation",
    "Indagation",
    "Inquisition"
    ]
    async with AsyncClient() as client:
        deps = Deps(client=client)
        
        while True:
            try:
                # Get user input
                user_input = console.input("[bold blue]You:[/bold blue] ")
                if user_input.lower() in ['exit', 'quit']:
                    break
                # Get response from agent
                with Live(Spinner("dots", text=random.choice(LOADING_MESSAGES),style="magenta"), refresh_per_second=5, console=console):
                    response = await agent.run(user_input, message_history=conversation_history, deps=deps)
                conversation_history.extend(response.new_messages())
                # Display response
                console.print("\n[bold green]Vani:[/bold green]")
                console.print(Markdown(response.output))
                console.print()
                
            except KeyboardInterrupt:
                break   
            except Exception as e:
                console.print(f"[red]Error: {e}[/red]")

    console.print("\n[yellow]Goodbye![/yellow]")

if __name__ == "__main__":
    asyncio.run(main())