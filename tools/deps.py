from dataclasses import dataclass
from httpx import AsyncClient

@dataclass 
class Deps:
    client: AsyncClient