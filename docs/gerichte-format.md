# Gerichteformat `kochrunde.dish/v1`

Mit diesem JSON-Format kommen Rezepte in die App: **Gerichte → Importieren**. Es ist so gebaut, dass ein KI-Assistent es
zuverlässig ausfüllen kann. Den fertigen Prompt dafür kopierst du in der App mit „Prompt kopieren"; er steht auch in
[`shared/dish.js`](../shared/dish.js) (`LLM_PROMPT`).

Geprüft wird an zwei Stellen mit demselben Code (`validateDish`): im Browser für die Vorschau und verbindlich auf dem Server.

## Beispiel

```json
{
  "format": "kochrunde.dish/v1",
  "name": "Tofu-Erdnuss-Curry mit Spinat und Reis",
  "slot": "dinner",
  "minutes": 35,
  "protein": 41,
  "kcal": 900,
  "tags": ["vegan"],
  "ingredients": [
    {"name": "Tofu natur", "amount": 200, "unit": "g", "category": "kuehl", "pack": {"size": 200, "label": "Pack 200 g"}},
    {"name": "Reis", "amount": 80, "unit": "g", "category": "trocken", "pack": {"size": 1000, "label": "Pack 1 kg"}},
    {"name": "Zwiebel", "amount": 0.5, "unit": "Stk", "category": "gemuese"},
    {"name": "Shiitake", "amount": 75, "unit": "g", "category": "gemuese", "store": "Asia-Laden"}
  ],
  "basics": ["Rote Currypaste", "Sojasoße", "Rapsöl"],
  "steps": ["Tofu würfeln und knusprig braten.", "Reis kochen.", "Sauce ansetzen, Tofu unterheben."],
  "tip": "Schmeckt aufgewärmt noch besser.",
  "source": "https://example.org/rezept"
}
```

Mehrere Gerichte auf einmal: eine Liste `[ {...}, {...} ]` oder `{"format": "kochrunde.dish/v1", "dishes": [ ... ]}`
(höchstens 100 pro Import). Text um das JSON herum und ```` ```json ````-Zäune werden ignoriert.

## Felder

| Feld | Pflicht | Bedeutung |
| --- | --- | --- |
| `name` | ja | Name des Gerichts, 2–120 Zeichen |
| `protein` | ja | Gramm Protein **pro Portion** |
| `kcal` | ja | Kalorien **pro Portion** |
| `slot` | nein | `breakfast`, `lunch`, `snack` oder `dinner` (Standard). Deutsche Wörter wie „Mittag" werden verstanden. |
| `minutes` | nein | Zubereitungszeit |
| `tags` | nein | Stichwörter für die Suche |
| `ingredients` | nein | Was frisch gekauft wird, siehe unten. Mengen **pro Portion**. |
| `basics` | nein | Gewürze, Öl, Soßen – nur Namen. Erscheinen beim Einkauf unter „Vorrat prüfen". |
| `steps` | nein | Zubereitungsschritte |
| `tip`, `source` | nein | Hinweis und Quelle |

### Zutat

| Feld | Pflicht | Bedeutung |
| --- | --- | --- |
| `name` | ja | Gleich geschriebene Zutaten mit gleicher Einheit werden auf der Einkaufsliste zusammengezählt |
| `amount` | ja | Zahl größer 0, pro Portion |
| `unit` | nein | `g`, `ml`, `Stk` (Standard), `EL`, `TL`, `Zehe`, `Scheibe`, `Stange`, `Bund`, `Dose`, `Prise`. `kg` und `l` werden umgerechnet. |
| `category` | nein | Regal im Laden: `gemuese`, `kuehl`, `brot`, `tk`, `trocken`, `huelsen`, `dose`, `nuss`, `gewuerz`, `getraenk`, `sonst` (Standard) |
| `pack` | nein | `{"size": 200, "label": "Pack 200 g"}` – übliche Packungsgröße in derselben Einheit. Dann zeigt die Liste „2×" statt Gramm. |
| `store` | nein | Spezialladen; solche Zutaten bekommen eine eigene Liste |

Unbekannte Felder werden verworfen. Bei Fehlern wird nichts importiert; die App zeigt je Gericht, was fehlt.
