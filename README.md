# Suntime

Webbapp (PWA) som visar sol i realtid på uteserveringar i Göteborg.

- Serveringar och byggnader hämtas från OpenStreetMap (Overpass API) direkt i webbläsaren.
- Skuggor räknas ut från byggnadshöjder (`shadow.js`) och solens position (SunCalc).
- Väder från Open-Meteo. Kartan använder OpenStreetMap-kartbitar via Leaflet.
- Inga API-nycklar eller betaltjänster behövs.

Kör lokalt: `python3 -m http.server` i mappen och öppna http://localhost:8000.
