from tools.deps import Deps
from pydantic import BaseModel

from pydantic_ai import RunContext

class LatLng(BaseModel):
    """A data structure to hold latitude and longitude coordinates."""
    lat: float
    log: float

async def get_weather(ctx:RunContext[Deps], location_description:str)->str:
    """
    Using the location description first find the latitude and longitude and then find the weather of the location
    Args:
        location_description: A specific place name or address. Ex: "Taj Mahal, Agra".
    Returns:
        The weather string
    Raises:
        ValueError: If the location cannot be found.
    """
    
    r=await ctx.deps.client.get("https://nominatim.openstreetmap.org/search", 
        params={
        'q':location_description,
        'format':'json',
        'limit':1
    },
        headers={"User-agent":"Vaani"}
    
    )
    r.raise_for_status() 
    data1 = r.json()
    if not data1:
        raise ValueError(f"Location not found: '{location_description}'")
    lat=data1[0]['lat']
    lon=data1[0]['lon']
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": lat,
        "longitude": lon,
        "current_weather": "true"
    }
    response = await ctx.deps.client.get(url, params=params)
    data=response.json()
    if not data:
        raise ValueError(f"Couldn't fetch weather data of {lat},{lon}")
    return data.get("current_weather")


        
