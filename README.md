# Overleaf Chat Studio

Lokale Chat-Oberfläche und MCP-Gateway, über die eine KI Overleaf-Projekte lesen und nach ausdrücklicher Freigabe ändern kann. Unterstützt werden **overleaf.com** und **selbst gehostete Overleaf-Instanzen** mit eigener Basis-URL.

> **Experimentell.** Der Connector nutzt private Web-Schnittstellen und den Projekt-Socket von Overleaf. Diese Schnittstellen sind nicht offiziell und können sich jederzeit ändern. Die Tests verwenden Mocks und lokale Fixtures. Für echte Instanzen ist die Kompatibilität nicht nachgewiesen. Zuerst mit einem entbehrlichen Projekt testen. Automatisierter Zugriff auf overleaf.com kann gegen die Nutzungsbedingungen verstoßen.

## Voraussetzungen

- Node.js ≥ 22.21 (der Server startet mit `--use-env-proxy`)
- Einmalig Chromium für Playwright: `npm run browser:install`
- Einen API-Schlüssel für den Chat: OpenAI oder ein eigener OpenAI-kompatibler Endpunkt (wird nur im Arbeitsspeicher des Browser-Tabs gehalten)

## Befehle

Alle Befehle im Projektordner ausführen.

| Zweck | Befehl |
|---|---|
| Abhängigkeiten installieren | `npm install` |
| Typecheck, Build und alle Tests | `npm run check` |
| Nur Tests | `npm test` |
| Entwicklung (UI: http://127.0.0.1:5173) | `npm run dev` |
| Produktion (vorher `npm run build`) | `npm start` → http://127.0.0.1:3001 |
| MCP über stdio | `npm run mcp` |

VS-Code-Aufgaben: **Studio: Entwicklung starten** und **Studio: Alles prüfen**.

## Ablauf im Chat-Studio

Die Oberfläche hat oben eine Navigationsleiste mit zwei Bereichen: **Chat** und **Einstellungen**. Die Statuschips rechts zeigen Verbindung, Projektauswahl sowie Endpunkt und Modell. Alle Einstellungen liegen in Fenstern im Bereich *Einstellungen*; Entwurf und Verlauf bleiben beim Wechsel erhalten.

1. *Einstellungen*: Instanz wählen (overleaf.com oder Self-hosted-Basis-URL), optional ein Projekt per Link oder ID.
2. **Browser öffnen**: Ein separates Chromium-Fenster mit einem flüchtigen Profil öffnet sich. Dort anmelden. Anmeldungen aus anderen Browsern werden nicht übernommen.
3. **Verbindung prüfen**, optional **Projektliste laden** und ein Projekt auswählen.
4. KI-Endpunkt und Modell wählen, API-Schlüssel eingeben, den Datenschutzhinweis bestätigen und die benötigten Freigaben setzen.
5. Im Bereich *Chat* schreiben. Wenn **Änderungen einzeln bestätigen** aktiv ist (Standard), werden Textänderungen und destruktive Aktionen nur vorgeschlagen. Sie werden mit Diff angezeigt und erst nach **Übernehmen** ausgeführt. Jeder Vorschlag gilt nur einmal und läuft nach 15 Minuten ab. Beim Übernehmen werden Revision und Bestätigungen erneut geprüft.

### Eigene KI-Endpunkte

Neben OpenAI lassen sich beliebige OpenAI-kompatible **Chat-Completions**-Endpunkte hinzufügen, z. B. `https://llm.example.org/api/v1`. Das geht per Formular (Endpunkt-URL, Modell-ID, Werkzeugaufrufe, Vision, Token-Grenzen) oder per **JSON-Import** im VS-Code-Format:

```json
[{
  "name": "https://llm.example.org/api/v1",
  "vendor": "customendpoint",
  "apiType": "chat-completions",
  "models": [{ "id": "model-a", "name": "Model A", "url": "https://llm.example.org/api/v1",
    "toolCalling": true, "vision": true, "maxInputTokens": 128000, "maxOutputTokens": 16000 }]
}]
```

- **Schlüssel:** Ein `apiKey` im JSON (auch ein Platzhalter wie `${input:…}`) wird ignoriert. Der Schlüssel wird je Endpunkt im Bereich *Einstellungen* eingegeben, nur im Arbeitsspeicher gehalten und ausschließlich an diesen Endpunkt gesendet.
- **Gespeichert** werden nur die Endpunkt-Definitionen ohne Schlüssel im `localStorage` des Browsers (höchstens 20 Endpunkte mit je 50 Modellen). Entfernen löscht sie wieder.
- **URL-Regeln:** HTTPS (lokal auch HTTP für `localhost`, `127.0.0.1`, `[::1]`), keine Zugangsdaten, kein Query/Fragment, keine Link-Local-Adressen. Die Prüfung läuft im Browser und erneut im Server. Der lokale Server ruft den Endpunkt auf. Er nutzt dabei `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` aus der Umgebung (Startflag `--use-env-proxy`). Lokale Endpunkte wie `http://127.0.0.1:11434` dann in `NO_PROXY` eintragen.
- **`toolCalling`:** Nur Modelle mit `"toolCalling": true` erhalten die Overleaf-Werkzeuge. Ohne den Eintrag läuft das Modell als reiner Chat ohne Overleaf-Zugriff (beim Import ist der Standard `false`, im Formular `true`).
- **Token-Grenzen:** `maxOutputTokens` wird als `max_completion_tokens` gesendet, `maxInputTokens` verkleinert bei kleinen Kontextfenstern die Dokumentgrenze für die KI (etwa 2 Zeichen pro Token). Manche Gateways lehnen `max_completion_tokens` ab. Dann das Feld leer lassen.
- `vision` wird nur angezeigt; Bilder werden derzeit nicht gesendet. Andere `apiType`-Werte als `chat-completions` werden abgelehnt.
- Der Datenschutzhinweis nennt den gewählten Endpunkt und muss nach einem Wechsel erneut bestätigt werden.

### Freigaben

| Freigabe | Wirkung | Dauer |
|---|---|---|
| Schreiben | Textdateien ändern/erstellen, Ordner, Umbenennen/Verschieben, Upload, Projekteinstellungen | bis zum Wechsel von Instanz oder Projekt |
| Projekt erstellen | genau ein Versuch zum Erstellen, Kopieren oder ZIP-Import, auch bei Fehlern verbraucht | eine Nachricht |
| Projektverwaltung | umbenennen, archivieren, wiederherstellen | eine Nachricht |
| Destruktiv | löschen, Upload überschreiben, Papierkorb/endgültig löschen (zusätzlich zu Schreiben bzw. Verwaltung) | eine Nachricht |
| Kommentare | hinzufügen, beantworten, auflösen/öffnen | eine Nachricht |

**Alle Freigaben erteilen** setzt alle fünf Freigaben auf einmal und behält sie auch nach jeder Nachricht, bis Instanz oder Projekt gewechselt wird. Die Einzelbestätigung mit Diff bleibt davon getrennt und standardmäßig aktiv. Bei mehreren offenen Vorschlägen gibt es **Alle übernehmen** und **Alle verwerfen**: Die Vorschläge werden der Reihe nach ausgeführt, Fehlschläge (z. B. Revisionskonflikt) werden je Vorschlag gemeldet, und enthaltene destruktive Aktionen stehen in der Schaltfläche.

Änderungen sind nur im ausdrücklich ausgewählten Projekt erlaubt. Text- und Kommentaränderungen setzen voraus, dass die Datei vorher gelesen wurde. Außerdem muss die zurückgegebene Revision unverändert übergeben werden. Fehlgeschlagene Änderungen werden nie automatisch wiederholt.

## Protokollunterstützung

- **ShareJS und History-OT**: Lesen, minimale Textänderungen, nachverfolgte Änderungen (`writeMode: "tracked"`), verankerte Kommentare und Kommentarstatus. Jede Änderung wird durch erneutes Lesen bestätigt. Wird eine nachverfolgte Änderung danach nicht beobachtet, meldet das Tool `PARTIAL_RESULT`. Es gibt keinen stillen Wechsel zu nicht nachverfolgten Änderungen.
- **Revisionen** binden Projekt, Dokument, Protokoll, OT-Version und Inhalts-Hash.
- **Legacy-Aliasse** `read_document`, `write_document` und `compile_document` nutzen denselben dokumentgebundenen Connector. Der Browser-Editor-Pfad ist nur ein Fallback für Adapter ohne Connector. Er prüft Projekt-URL und ausgewählte Datei im selben Schritt wie Lesen und Schreiben.
- **Große Dokumente**: Ab 150 000 Zeichen erhält die KI keinen Volltext. Sie arbeitet dann mit `get_sections`, `get_section_content` und `write_section`. Einzelne Werkzeugergebnisse sind auf 400 000 Zeichen begrenzt. Ausgelassene Felder werden ausdrücklich gekennzeichnet.
- `validate_latex` prüft nur statisch und ersetzt keine Kompilierung. `preview_edit` schreibt nicht.

## MCP-Gateway

Externe MCP-Clients nutzen denselben Werkzeugkern. Schreib- und Verwaltungsrechte legt ausschließlich der Betreiber über Umgebungsvariablen fest. Die KI kann sie nicht selbst setzen.

| Variable | Wirkung |
|---|---|
| `OVERLEAF_ALLOW_WRITES=1` | Schreiben erlauben (sonst nur Lesen) |
| `OVERLEAF_ALLOW_CREATE_PROJECTS=1` | Erstellen, Kopieren und Import erlauben (ein Versuch pro Verbindung) |
| `OVERLEAF_ALLOW_MANAGE_PROJECTS=1` | Projektverwaltung erlauben |
| `OVERLEAF_ALLOW_DESTRUCTIVE=1` | Destruktive Aktionen erlauben |
| `OVERLEAF_ALLOW_COMMENTS=1` | Kommentare erlauben |
| `MCP_NETWORK=1` | WebSocket- und TCP-Gateway aktivieren |
| `MCP_GATEWAY_TOKEN` | Pflicht bei `MCP_NETWORK=1`, mindestens 32 Zeichen |
| `MCP_TCP_PORT` | TCP-Port (Standard 3002) |
| `PORT` | HTTP-Port (Standard 3001) |

**stdio** (Beispiel für eine MCP-Client-Konfiguration):

```json
{
  "servers": {
    "overleaf-studio": {
      "type": "stdio",
      "command": "npm",
      "args": ["run", "--silent", "mcp"],
      "cwd": "/pfad/zu/AI Overleaf Agent",
      "env": { "OVERLEAF_ALLOW_WRITES": "0" }
    }
  }
}
```

**WebSocket** `ws://127.0.0.1:3001/mcp`: Eine JSON-RPC-Nachricht pro Textframe. Die Authentifizierung erfolgt beim Upgrade mit `Authorization: Bearer <MCP_GATEWAY_TOKEN>`.

**TCP** `127.0.0.1:3002`: NDJSON. Die erste Zeile muss `{"auth":"<MCP_GATEWAY_TOKEN>"}` sein. Fehlt sie oder ist sie falsch, wird die Verbindung beendet (Timeout 10 s).

WebSocket und TCP sind eigene Transportadapter, keine standardisierten MCP-Remote-Endpunkte. Es sind höchstens vier gleichzeitige Gateway-Verbindungen möglich. Nachrichten sind auf 1 MiB begrenzt. Das Gateway nimmt keine Anhänge an und liefert bei `download_file` nur Metadaten, keine Binärdaten.

## Sicherheitsmodell und Datenschutz

- Der Server lauscht nur auf `127.0.0.1`. Host und Origin werden geprüft, zustandsändernde Routen benötigen ein CSRF-Token. Zusätzlich gelten Sicherheitsheader, eine CSP und Größenlimits.
- API-Schlüssel, Cookies, Chatverläufe, Dokumentinhalte und Anhänge werden nicht gespeichert und nicht protokolliert. Die Overleaf-Anmeldung liegt nur im flüchtigen Chromium-Kontext. Offene Änderungsvorschläge liegen höchstens 15 Minuten im Arbeitsspeicher und werden bei erneutem Verbinden verworfen.
- Chat und gelesene Dokumentinhalte gehen an den gewählten KI-Endpunkt (OpenAI oder Ihr eigener). Anhangbytes und Downloads gehen nicht an das Modell.
- Lokale Vertrauensgrenze: Andere Prozesse auf demselben Rechner können das CSRF-Token über `/api/session` abrufen. Die Freigabe-Checkboxen sind keine Authentifizierung gegenüber lokalen Prozessen.

## Bekannte Grenzen

- Live geprüft (2026-10-03) wurde gegen eine Self-hosted-Instanz (ShareJS, ohne Review-Funktion) und, nur Schreiben im Wegwerfprojekt, gegen overleaf.com (ebenfalls ShareJS): Lesen, Schreiben, Dateiverwaltung, Import/Kopie, Einstellungen, Kompilieren, Verlauf und MCP über TCP, WebSocket und stdio. **Nicht live geprüft** sind History-OT (keine der beiden Instanzen lieferte es), nachverfolgte Änderungen (beide lehnten sie ab), Kommentare und der Chat mit echtem KI-Schlüssel. Private Overleaf-Schnittstellen ändern sich ohne Vorankündigung. Bitte zuerst mit einem Wegwerfprojekt testen.
- Die Projektliste umfasst nur zugängliche Projekte. Die Abschnittserkennung ist lexikalisch und berücksichtigt keine `\input`/`\include`-Dateien.
- Ein Kompilieren verbraucht Compile-Kontingent der Instanz.

## Lizenz

[MIT](LICENSE)
