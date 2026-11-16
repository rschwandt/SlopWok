# Kochrunde

Essensplan, Einkauf und Kasse für mehrere Leute – als Web-App fürs Handy. Entstanden aus einer Einzelnutzer-App für
einen veganen High-Protein-Monatsplan; dessen 41 Gerichte sind als Startbibliothek dabei.

- **Haushalt:** Per Einladungscode beitreten. Gemeinsame Mahlzeiten planen: wer isst wie viele Portionen mit, wer kocht,
  wer nimmt den Rest am nächsten Tag als Mittag.
- **Einkauf:** Die Liste rechnet aus dem Plan die Mengen für alle Esser, rundet auf Packungen und sortiert nach Regal.
  Die App schlägt vor, wer dran ist (wer zuletzt am seltensten einkaufen war).
- **Kasse:** Wer einkauft, trägt den Betrag ein. Aufgeteilt wird gleichmäßig oder nach Verbrauch (geplante Kalorien in
  den Einkaufstagen). Salden und Ausgleichszahlungen inklusive.
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

Die Daten liegen in `data/kochrunde.db` (SQLite). Backup = diese Datei kopieren.

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
kochrunde.example.org {
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
server/logic.js    Einkaufsliste, Kostenverteilung, Fortschritt, Serie
server/db.js       SQLite-Schema, spielt server/seed.json ein
server/push.js     Web Push (VAPID + aes128gcm) ohne Fremdbibliothek
shared/dish.js     Gerichteformat: Prüfung, Import, LLM-Prompt (läuft in Browser und Server)
public/            die Web-App (ES-Module, kein Framework)
tools/build-seed.mjs  erzeugt server/seed.json aus der ursprünglichen Einzelnutzer-App
```

## Was bewusst (noch) fehlt

- Kein Offline-Modus: Die App braucht Verbindung zum Server.
- Die Vorratsrechnung der alten App (angebrochene Packungen und Haltbarkeit über mehrere Einkäufe hinweg) ist nicht
  übernommen. Jeder Einkauf rechnet seine Tage für sich und rundet auf ganze Packungen.
- Kein „Passwort vergessen" (es gibt keine E-Mail-Adressen). Zurücksetzen geht nur direkt in der Datenbank.
- Ein Konto gehört immer zu genau einem Haushalt.

Schriften: Bricolage Grotesque und Figtree (SIL Open Font License), lokal ausgeliefert.
