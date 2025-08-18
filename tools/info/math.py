import httpx
from pydantic import BaseModel, Field
from enum import Enum
from pydantic_ai import RunContext
from tools.deps import Deps # Assuming this is your dependency setup

class MathOperation(str, Enum):
    """Enumeration of available mathematical operations."""
    SIMPLIFY = "simplify"
    FACTOR = "factor"
    DERIVE = "derive"
    INTEGRATE = "integrate"
    ZEROES = "zeroes"
    TANGENT = "tangent"
    AREA = "area"
    COS = "cos"
    SIN = "sin"
    TAN = "tan"
    ARCCOS = "arccos"
    ARCSIN = "arcsin"
    ARCTAN = "arctan"
    ABS = "abs"
    LOG = "log"

class MathInput(BaseModel):
    """Input model for the math tool."""
    operation: MathOperation = Field(..., description="The mathematical operation to perform.")
    expression: str = Field(..., description="The URL-encoded math expression. For tangent lines, use 'c|f(x)'. For area, use 'c:d|f(x)'.")

async def do_math(ctx: RunContext[Deps], args: MathInput) -> str:
    """
    Performs a variety of symbolic and numerical math operations.

    This tool can simplify expressions, factor polynomials, find derivatives,
    calculate integrals, find zeroes, and more.
    """
    try:
        # Construct the URL from the validated input model
        url = f"https://newton.vercel.app/api/v2/{args.operation.value}/{args.expression}"
        
        
        response = await ctx.deps.client.get(url)
        response.raise_for_status()
        data = response.json()
        result = data.get("result")

        if result is None:
            return "Error: The API response did not contain a 'result' key."

        return f"The result of the operation '{args.operation.value}' on the expression '{args.expression}' is: {result}"

    except httpx.HTTPStatusError as e:
        return f"Error: The math API returned a status code {e.response.status_code}. Please check your operation and expression."
    except httpx.RequestError as e:
        return f"Error: A network error occurred while contacting the math API: {e}"
    except Exception as e:
        return f"An unexpected error occurred: {e}"