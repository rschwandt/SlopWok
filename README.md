# SlopWok

Essensplan, Einkauf und Kasse für mehrere Leute – als Web-App fürs Handy. Entstanden aus einer Einzelnutzer-App für
einen veganen High-Protein-Monatsplan; dessen 41 Gerichte sind als Startbibliothek dabei.

- **Haushalt:** Per Einladungscode beitreten. Gemeinsame Mahlzeiten planen: wer isst wie viele Portionen mit, wer kocht,
  wer nimmt den Rest am nächsten Tag als Mittag.
- **Einkauf:** Die Liste rechnet aus dem Plan die Mengen für alle Esser, rundet auf Packungen und sortiert nach Regal.
  Die App schlägt vor, wer dran ist (wer zuletzt am seltensten einkaufen war).
- **Kasse:** Wer einkauft, trägt den Betrag ein. Aufgeteilt wird gleichmäßig oder nach Verbrauch (geplante Kalorien in
  den Einkaufstagen). Salden und Ausgleichszahlungen inklusive.
- **Ziele:** Aus Gewicht, Größe, Alter, Aktivität und Ziel (abnehmen, halten, zunehmen, Muskelaufbau) berechnet die App
  Mindestwerte für Kalorien und Protein (Mifflin-St Jeor). Eigene Werte gehen weiterhin.
- **Vorschläge oder selbst planen:** Im Vorschlagsmodus füllt die App freie Mahlzeiten aus dem Fundus – abwechslungsreich
  und passend zum Proteinziel, mit „Tauschen" pro Mahlzeit. Wer lieber selbst plant, schaltet das ab.
- **Fortschritt:** Protein- und Kalorienziel pro Tag, Wochenübersicht, Serie. Sichtbar für niemanden, den Haushalt oder
  alle – jede Person entscheidet selbst. Wer sichtbar ist, kann angestupst werden (In-App und per Push).
- **Gerichte:** Von Hand anlegen oder als JSON importieren, das ein KI-Assistent ausfüllt:
  [docs/gerichte-format.md](docs/gerichte-format.md).

## Starten

Braucht nur Node.js ab 22.13 – keine Abhängigkeiten, kein Build-Schritt.

```sh
npm start          # http://localhost:8787
npm test
```

Die Daten liegen in `data/slopwok.db` (SQLite; eine ältere `data/kochrunde.db` wird weiterbenutzt). Backup = diese Datei kopieren.

| Variable | Bedeutung |
| --- | --- |
| `PORT`, `HOST` | Standard `8787` / `0.0.0.0` |
| `DATA_DIR` | Ordner für die Datenbank, Standard `./data` |
| `REGISTRATION_CODE` | Wenn gesetzt, braucht man diesen Code zum Registrieren. Für öffentlich erreichbare Server empfohlen. |
| `TRUST_PROXY=1` | Hinter einem Reverse Proxy setzen (wertet `X-Forwarded-Proto`/`-For` aus) |
| `VAPID_SUBJECT` | Kontakt für die Push-Dienste, z. B. `mailto:du@example.org`. Apple lehnt Platzhalter ab. |

## Im Netz betreiben

Push-Benachrichtigungen und „Zum Home-Bildschirm" brauchen **HTTPS**. Am einfachsten: Node auf einem kleinen Server
laufen lassen und einen Reverse Proxy davor, z. B. Caddy:

```
slopwok.example.org {
    reverse_proxy localhost:8787
}
```

dazu `TRUST_PROXY=1 REGISTRATION_CODE=… VAPID_SUBJECT=mailto:… npm start`.

Auf dem iPhone funktionieren Push-Benachrichtigungen erst, wenn die App über Safari auf dem Home-Bildschirm liegt
(iOS 16.4 oder neuer). Anstupser erscheinen unabhängig davon unter „Leute".

## Aufbau

```
server/index.js    HTTP-Server, statische Dateien, Cookies, Schutz vor fremden Ursprüngen
server/api.js      alle /api-Routen
server/auto.js     Vorschlagsmodus: Gerichtauswahl und automatisches Füllen
server/logic.js    Einkaufsliste, Kostenverteilung, Fortschritt, Serie
server/db.js       SQLite-Schema, spielt server/seed.json ein
server/push.js     Web Push (VAPID + aes128gcm) ohne Fremdbibliothek
shared/dish.js     Gerichteformat: Prüfung, Import, LLM-Prompt (läuft in Browser und Server)
public/            die Web-App (ES-Module, kein Framework)
public/js/woki.js  Woki, das Maskottchen (SVG, drei Stimmungen); Quelle für die App-Icons
tools/build-seed.mjs  erzeugt server/seed.json aus der ursprünglichen Einzelnutzer-App
tools/build-icons.mjs erzeugt public/icons/ aus woki.js (braucht rsvg-convert)
```

## Was bewusst (noch) fehlt

- Kein Offline-Modus: Die App braucht Verbindung zum Server.
- Die Vorratsrechnung der alten App (angebrochene Packungen und Haltbarkeit über mehrere Einkäufe hinweg) ist nicht
  übernommen. Jeder Einkauf rechnet seine Tage für sich und rundet auf ganze Packungen.
- Kein „Passwort vergessen" (es gibt keine E-Mail-Adressen). Zurücksetzen geht nur direkt in der Datenbank.
- Ein Konto gehört immer zu genau einem Haushalt.

## Aussehen

Woki's Teahouse: Pfirsichblüten-Papier, Seladon-Glasur, Porzellanblau und ein Zinnober-Siegel. Woki, der Wok mit
Gesicht, ist Logo und App-Icon und meldet sich in drei Stimmungen: fröhlich (Kopf, Anmeldung), angestupst
(Anstupser auf „Heute", in „Neuigkeiten" und als Push-Symbol) und müde (alles gegessen, oder abends nichts mehr
geplant). Farben stehen als Variablen oben in `public/app.css`; Textfarben haben eigene `*-ink`-Varianten mit
ausreichend Kontrast.

Schriften: Zen Old Mincho und Zen Maru Gothic, lokal ausgeliefert (nur der lateinische Zeichensatz). Das Siegel
镬 stammt aus Ma Shan Zheng und ist als Pfad in `woki.js` eingebettet. Alle drei: SIL Open Font License.
