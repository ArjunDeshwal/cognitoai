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
from tools.web_search import search_web
from tools.weather import get_weather
from kittentts import KittenTTS
import sounddevice as sd

# 'if-token-present' means nothing will be sent (and the example will work) if you don't have logfire configured
# logfire.configure(send_to_logfire='if-token-present')
# logfire.instrument_pydantic_ai()
# Initialize console for pretty output
console = Console()

# Initialize Ollama
llm = OpenAIModel(
    model_name="qwen3:1.7b", provider=OpenAIProvider(base_url="http://localhost:11434/v1")
)

# Create memory
async def limit_tokens(messages: list[ModelMessage], max_tokens: int = 15000) -> list[ModelMessage]:
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
tools = [search_web, get_weather]

# Create agent
agent = Agent(model=llm, history_processors=[limit_tokens], 
              tools=tools, 
              system_prompt="""You are Vani, a local AI-assistant. You have to help the user in general tasks. For the things that you don't know Try to use the web_search tool. Don't answer to inappropriate questions though. Avoid using emojis. Use the get_weather to get the weather of a location.""",
              
              )
m = KittenTTS("KittenML/kitten-tts-nano-0.1")
# Main chat loop
async def main():
    console.print("[bold green]Jarvis Started![/bold green]")
    console.print("Type 'exit' to quit\n")
    conversation_history:list[ModelMessage]=[]
    mute=False
    global m
    async with AsyncClient() as client:
        deps = Deps(client=client)
        
        while True:
            try:
                # Get user input
                user_input = console.input("[bold blue]You:[/bold blue] ")
                if user_input.lower() in ['exit', 'quit']:
                    break
                if user_input.lower() == 'mute':
                    mute=True
                # Get response from agent
                response = await agent.run(user_input, message_history=conversation_history, deps=deps)
                conversation_history.extend(response.new_messages())
                # Display response
                console.print("\n[bold green]Jarvis:[/bold green]")
                console.print(Markdown(response.output))
                if not mute:
                    audio=m.generate(response.output, voice='expr-voice-4-f')
                    sd.play(audio, 26000)
                    sd.wait()
                console.print()
                
            except KeyboardInterrupt:
                break   
            except Exception as e:
                console.print(f"[red]Error: {e}[/red]")

    console.print("\n[yellow]Goodbye![/yellow]")

if __name__ == "__main__":
    asyncio.run(main())