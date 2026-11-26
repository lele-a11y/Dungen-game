[README.md](https://github.com/user-attachments/files/35468764/README.md)
# Leo's Dungeon RPG – Setup & Deployment

Echtzeit-Multiplayer-Dungeon-RPG (Node.js + Socket.io Server, Canvas-Client).
Klassen: Krieger, Magier, Schurke. Bis zu ~6 Spieler gleichzeitig, Monster,
Items, Leveling.

## 1. Lokal testen (optional)

```
npm install
npm start
```

Dann im Browser: http://localhost:3000

## 2. Dauerhafte Accounts einrichten (MongoDB Atlas, kostenlos)

Damit Login/Passwort und Spielstände (Level, Gold, Tränke) auch Server-Neustarts
überleben, braucht es eine externe Datenbank. MongoDB Atlas hat eine kostenlose
Stufe, die dafür locker reicht.

1. Gehe auf https://www.mongodb.com/cloud/atlas/register und erstelle einen
   kostenlosen Account.
2. Beim Einrichten: **"M0 Free"**-Cluster auswählen (Region egal, z.B. Frankfurt).
3. **Database Access** → neuen Datenbank-User anlegen (Benutzername + Passwort
   notieren).
4. **Network Access** → **"Allow access from anywhere"** (0.0.0.0/0) hinzufügen
   (für den Anfang am einfachsten).
5. Auf **"Connect"** beim Cluster → **"Drivers"** → die Connection-String-URL
   kopieren, sieht etwa so aus:
   `mongodb+srv://BENUTZER:PASSWORT@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`
6. Im String `BENUTZER` und `PASSWORT` durch deine echten Zugangsdaten ersetzen.
7. Diesen fertigen String brauchst du gleich als Umgebungsvariable `MONGO_URI`
   bei Render (siehe nächster Abschnitt).

Ohne `MONGO_URI` läuft das Spiel trotzdem, aber Accounts/Fortschritt werden
dann NICHT gespeichert.

## 3. Kostenlos auf Render deployen

1. Erstelle einen kostenlosen Account auf https://render.com
2. Lade diesen Ordner (`dungeon-rpg/`) in ein neues GitHub-Repository hoch
   (oder nutze "Deploy from Git" mit einem eigenen Repo).
3. In Render: **New +** → **Web Service** → dein Repo auswählen
4. Einstellungen:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Unter **"Environment"** → **"Add Environment Variable"**:
   - Key: `MONGO_URI`
   - Value: der Connection-String aus Schritt 2 (MongoDB Atlas)
   - Optional, für Admin-Rechte: Key `ADMIN_USERNAMES`, Value z.B. `dein_benutzername` (mehrere Namen mit Komma trennen, z.B. `leo,max`). Wer sich mit einem dieser Benutzernamen einloggt, sieht im Spielmenü das 👑 Admin-Panel (Gold/Tränke verschenken, Server-Ansagen, Monsterwelle auslösen, alle heilen).
6. Deploy klicken. Nach ein paar Minuten bekommst du eine URL wie
   `https://leo-dungeon-rpg.onrender.com`

Hinweis: Der kostenlose Render-Plan "schläft" nach Inaktivität ein und
braucht beim ersten Aufruf ca. 30-60 Sekunden zum Aufwachen. Für ein
Hobby-Projekt völlig ok.

Alternativen mit ähnlichem Ablauf: Railway.app, Fly.io.

## 4. Auf leo.widescreen.ch einbinden

Da dein Haupthosting (METANET, per FileZilla) kein Node.js ausführen kann,
bleibt die Website dort – du verlinkst nur auf den extern gehosteten Server.

**Einfachste Variante:** Einen Link/Button auf deiner Seite platzieren:

```html
<a href="https://leo-dungeon-rpg.onrender.com" target="_blank">
  ⚔️ Jetzt spielen: Leo's Dungeon
</a>
```

**Alternative (eingebettet via iframe)** – lade dazu z.B. eine kleine
`game.html` mit folgendem Inhalt per FileZilla hoch und verlinke diese:

```html
<!DOCTYPE html>
<html>
<head><title>Leo's Dungeon</title>
<style>html,body{margin:0;height:100%;}iframe{width:100%;height:100%;border:0;}</style>
</head>
<body>
<iframe src="https://leo-dungeon-rpg.onrender.com" allow="fullscreen"></iframe>
</body>
</html>
```

## Dateien

- `server.js` – Spiel-Server (Bewegung, Kämpfe, Monster-KI, Items, Leveling)
- `public/index.html` – Client (Canvas-Rendering, Steuerung, HUD)
- `package.json` – Abhängigkeiten (express, socket.io)

## Steuerung im Spiel

- **WASD / Pfeiltasten**: Bewegen
- **Leertaste / Linksklick**: Angriff (Magier zielt Richtung Maus)
- **E**: Heiltrank benutzen
- **Enter** (im Chat-Feld): Nachricht senden

## Mögliche Erweiterungen (später)

- Weitere Dungeon-Level / Portale zwischen Räumen
- Ausrüstung (Waffen/Rüstung) statt nur Tränke
- Boss-Monster
- Persistente Charaktere (Datenbank statt In-Memory)

## Dungeons (levelabhängig)

Jeder Dungeon hat eine eigene, bei jedem Serverstart neu generierte Karte, eigene Farben und eigene Monster.
Nach dem Einloggen und nach jedem Tod landest du automatisch im höchsten Dungeon, den dein Level erlaubt.
Im Menü unter "Dungeon wählen" kannst du jederzeit in niedrigere Dungeons wechseln.

| Dungeon | ab Level | Stil | Monster |
|---|---|---|---|
| Moosige Höhle | 1 | Höhle | Goblin, Schleim, Fledermaus, Bogenschütze |
| Verlassene Mine | 8 | Räume und Gänge | Goblin, Ork, Fledermaus, Bogenschütze |
| Katakomben | 15 | Labyrinth | Skelett, Fledermaus, Ork, Bogenschütze, Hexer |
| Eishöhlen | 25 | Höhle | Troll, Schleim, Skelett, Hexer, Säurespucker |
| Vulkan-Festung | 35 | grosse Hallen | Troll, Dämon, Skelett, Hexer |
| Der Abgrund | 50 | Labyrinth | Dämon, Troll, Hexer, Säurespucker |

Die Werte (Level, Stärke, Monster) stehen oben in `server.js` in `DUNGEON_TIER_DEFS` und lassen sich dort anpassen.
Die Minimap oben rechts zeigt dich (weiss), andere Spieler (blau) und den Boss (rot).

## Klassen-Fähigkeiten (Taste Q, Mobile: Button rechts unten)

| Klasse | Fähigkeit | Wirkung | Abklingzeit |
|---|---|---|---|
| Krieger | Wirbelschlag | 1,6-facher Schaden an allen Gegnern im Umkreis (in der Arena auch an Spielern) | 8 s |
| Magier | Feuernova | Ring aus 12 Geschossen | 10 s |
| Schurke | Schattenschritt | Sprung in Zielrichtung, der nächste Nahkampfangriff ist ein sicherer Krit | 7 s |

Werte und Abklingzeiten stehen in `server.js` bei `ABILITIES` und in `useAbility`.

## Quests (Menü → Quests)

Jeder Spieler hat immer drei offene Quests (Monster besiegen, bestimmte Monsterart, Truhen öffnen, Gold sammeln,
Boss besiegen, Spieler in der Arena besiegen). Belohnungen (Gold, XP, Tränke) wachsen mit dem Dungeon, der zu deinem Level passt.
Nicht passende Quests lassen sich mit "Tauschen" ersetzen. Der Fortschritt wird in der Datenbank gespeichert.

## Charakter, Ausrüstung und Handwerk (Taste C)

- **Ausrüstung:** Waffe, Rüstung und Ring in vier Seltenheiten (Gewöhnlich, Selten, Episch, Legendär). Sie fallen von Monstern (5%), aus Truhen (25%) und von Bossen (3 Stück, mindestens eines episch). Bis zu 30 im Inventar, volle Taschen werden automatisch verkauft.
- **Verbessern:** bis +5, jede Stufe macht einen Gegenstand um 15% stärker. Kostet Essenz und Gold.
- **Essenz (✦):** fällt bei jedem besiegten Monster, Bosse geben 25. Damit werden Gegenstände verbessert und Tränke hergestellt.
- **Fertigkeiten:** 1 Punkt pro Levelaufstieg für Schnelle Erholung, Kampfkunst, Zähigkeit und Goldnase (je bis Stufe 5). Zurücksetzen kostet 200 Gold.
- **Aussehen:** Farben und Hüte für Gold, dazu ein Wolf als Begleiter (400 Gold), der Gegner in der Nähe angreift.

## Erfolge, Rangliste, Tagesbelohnung

18 Erfolge mit Goldbelohnung. Rangliste (Level, Kills, Bosse, Arena) kommt direkt aus der Datenbank. Wer sich täglich anmeldet, bekommt eine Belohnung, die bis zur 7-Tage-Serie wächst.

## Soziales

- **Gruppen** bis 4 Spieler: Mitglieder in der Nähe bekommen 50% XP und Quest-Fortschritt, eigener Chat mit `/g Text`.
- **Freundesliste** (bis 50) mit Online-Anzeige, Gruppeneinladung und Teleport-Anfrage.
- **Handel:** Im Reiter Ausrüstung bei einem Gegenstand auf "Handeln" klicken. Der andere sieht Werte und Preis und muss zustimmen.
- Pro Account ist nur eine Sitzung gleichzeitig möglich, eine zweite Anmeldung beendet die erste. Das verhindert Gegenstands-Duplikate.

## Gefahren und Ereignisse

- **Statuseffekte:** Schleim und Troll verlangsamen, Fledermäuse vergiften, Dämonen setzen in Brand. Ein Heiltrank entfernt sie.
- **Dungeon-Bosse:** Jeder Dungeon hat alle 8 Minuten einen eigenen Boss. Alle Bosse haben einen Bodenangriff mit rotem Warnkreis, dem man ausweichen kann.
- **Zufallsereignisse** alle 4 bis 8 Minuten: Schatzgoblin (flieht, 2 Minuten Zeit, viel Beute), Hinterhalt und Segen.
- **Sound:** Effekte werden im Browser erzeugt, im Menü schaltbar.

## Admin und Schutz

Das Admin-Panel kann Spieler kicken und sperren (Sperre bleibt im Account gespeichert) und die Ereignisse oben auslösen.
Schutz: Sperre nach 6 Fehlanmeldungen für 5 Minuten, höchstens 5 Registrierungen pro Stunde und Adresse, Chat-Bremse und ein Limit für Paketfluten.
Aus Bandbreitengründen sendet der Server pro Spieler nur, was in Bildschirmnähe ist.

## Fernkampf-Gegner und Trefferfläche

- **Bogenschütze** (🏹) schiesst Pfeile, **Hexer** (🔮) feuert Feuerbälle (setzt in Brand), **Säurespucker** (☣️) vergiftet. Sie halten Abstand, rücken vor, wenn du zu weit weg bist, und schiessen nur bei freier Sicht, nicht durch Wände. Ihre Geschosse sind langsam genug zum Ausweichen.
- **Trefferfläche:** Nahkampf, Geschosse, Wirbelschlag und Wolf berücksichtigen jetzt die Körpergrösse. Grosse Gegner und vor allem Bosse lassen sich deutlich leichter treffen, kleine Gegner wie bisher.

## Einstellungen per .env-Datei (z.B. bei Infomaniak)

Der Server liest `MONGO_URI` und `ADMIN_USERNAMES` aus den Umgebungsvariablen. Wenn dein Hoster dafür kein Eingabefeld hat,
kopiere `.env.example` zu `.env`, trage deine Werte ein und lege die Datei in den Projektordner (neben `server.js`).
Die Datei enthält dein Datenbank-Passwort: **nie ins GitHub-Repo hochladen** (steht schon in `.gitignore`).

## Umzug zu Infomaniak (Node.js-Hosting)

1. Im Infomaniak-Manager ein Web-Hosting mit **Node.js-Website** bestellen (30 Tage gratis testen) und die Domain zuweisen.
2. Code per Git, ZIP oder SFTP hochladen (`package.json` direkt im Hauptordner).
3. Im Reiter Node.js: Build-Befehl `npm install`, Start-Befehl `npm start`. Den Port setzt Infomaniak selbst über `PORT`.
4. `MONGO_URI` und `ADMIN_USERNAMES` eintragen (Feld im Manager oder `.env`-Datei).
5. SSL-Zertifikat aktivieren, Anwendung neu starten und `https://deine-domain.ch` öffnen.
6. In MongoDB Atlas unter Network Access die IP-Adresse des Servers erlauben (oder `0.0.0.0/0`).

## Grafik

- Spielfiguren, Wolf und alle Gegner werden als gezeichnete Figuren mit Schatten, Farbverlauf, Augen und Waffen dargestellt (Krieger mit Schwert und Schild, Magier mit leuchtendem Stab, Schurke mit zwei Dolchen). Gegner schauen zum Spieler.
- Name, Level und Hut sitzen direkt an der Figur, der Lebensbalken direkt darunter.
- Bewegungen sind weich statt ruckelig, Böden und Wände haben Struktur und Schatten, Geschosse hinterlassen eine Leuchtspur, Treffer, Tode und Levelaufstiege erzeugen Partikel, Boss-Schläge und eigene Treffer wackeln die Kamera leicht.
- Im Menü unter "Grafik" lässt sich zwischen Hoch und Niedrig (schneller) wechseln. Auf Handys startet das Spiel standardmässig mit Niedrig.

## Handy-Bedienung

- **Schwebender Joystick:** Tippe irgendwo in der linken Bildschirmhälfte, der Joystick erscheint unter deinem Daumen.
- **Angriffsknopf:** Gedrückt halten = Dauerangriff. Das Spiel zielt dabei automatisch auf den nächsten Gegner (in der Arena auf den nächsten Spieler).
- Bewegen und Angreifen gleichzeitig funktioniert (früher las der Joystick den falschen Finger).
- **Chat:** Menü → "Nachricht schreiben" (`/g` für die Gruppe, `/gc` für die Gilde). Menü → "Vollbild", wenn der Browser es kann.
- Zoomen und versehentliches Markieren sind abgeschaltet, Tippflächen sind grösser, Randbereiche (Notch) werden freigehalten. Im Hochformat erscheint ein Hinweis, dass Querformat bequemer ist.

## Balance

- Gegner sind in jedem Dungeon so stark, dass ein normaler Gegner am Dungeon-Anfang etwa 2 bis 4 Sekunden braucht und du etwa 9 bis 19 Sekunden gegen einen einzelnen überlebst (Krieger ohne Ausrüstung). Grosse Nahkämpfer (Ork, Troll, Dämon) sind Elitegegner.
- Die Klassen machen pro Sekunde etwa gleich viel Schaden (Schaden aus Level, Waffe und Upgrades skaliert mit der Angriffsgeschwindigkeit), dafür unterscheiden sich Leben, Tempo und Reichweite.
- Gold-Belohnungen wurden angepasst, Bosse schlagen etwas langsamer und weniger hart zu (Gruppeninhalt).
- Alle Werte stehen oben in `server.js`: `DUNGEON_TIER_DEFS` (Gegnerstärke, Schadensfaktor, Beute), `CLASSES` und `MONSTER_TYPES`.

## Boss-Fähigkeiten

Jeder Boss hat neben dem Bodenschlag eigene Angriffe (mit Warnzeichen):

| Dungeon | Boss | Fähigkeiten |
|---|---|---|
| Moosige Höhle | Moosriese | Verstärkung rufen, Wutphase |
| Verlassene Mine | Minenwächter | Steinschlag, Wutphase |
| Katakomben | Knochenfürst | Verstärkung, Geschossfächer |
| Eishöhlen | Frostkoloss | Fächer (verlangsamt), Steinschlag |
| Vulkan-Festung | Magmatitan | Steinschlag, Fächer (Brand), Wutphase |
| Der Abgrund | Abgrundherrscher | alles (Fächer vergiftet) |
| Boss-Raum | Dungeon-Wächter | Verstärkung, Fächer, Wutphase |

Unter 30% Leben tobt ein Boss: schneller, härter, Angriffe öfter. Seine Verstärkungen verschwinden mit ihm.

## Gilden (Menü → Soziales → Gilde)

- Gründen kostet 500 Gold (Name 3–16 Zeichen, Kürzel 2–4). Bis zu 20 Mitglieder, jedes Mitglied darf einladen, der Anführer kann Mitglieder entfernen und die Gilde auflösen. Verlässt der Anführer die Gilde, übernimmt das nächste Mitglied.
- Das Kürzel steht in eckigen Klammern vor dem Namen. Gildenchat mit `/gc Text`.
- Bonus: +5% XP pro Gildenmitglied in deiner Nähe (höchstens +15%).
- Gilden liegen in der Datenbank (Sammlung `guilds`).

## Musik

Wird im Browser erzeugt, ohne Dateien: Jeder Dungeon, die Arena und der Boss-Raum haben eine eigene Tonart und Stimmung, Arena, Boss-Raum und Vulkan-Festung zusätzlich einen Puls. Im Menü getrennt von den Soundeffekten ein- und ausschaltbar.

## Update: Stadt, Tresore, Wiedergeburt, Raid & Saison

**Hub-Stadt** (Menü → 🏘️ Zur Stadt): sicherer Ort mit Heilbrunnen und fünf NPCs (Taste F oder Button):
Händler (Shop), Schmied (Ausrüstung/Verbessern), Questgeberin, Herold (Raid & Saison), Meister der Wiedergeburt.

**Dungeon-Mechaniken** (in jeder Stufe):
- Stachelfallen: 0,6 s Warnblinken, dann 0,8 s aktiv, 7 % deines max. Lebens als Schaden.
- Tresorräume: verschlossene Tür (🔑 Schlüssel nötig, F). Schlüssel droppen selten von Monstern, aus Truhen, von Bossen und dem Raid. Drinnen: Truhe mit Epischem und viel Gold. Füllt sich nach 8 Min wieder.
- Geheimräume: eine Wand, die bei einem Angriff in der Nähe nachgibt (feine Risse, wenn man nah dran ist). Zwei Truhen drin, Schließung nach 5 Min.

**Zweite Fähigkeit (Taste T, auf dem Handy eigener Button):**
Krieger *Bollwerk* (5 s halber Schaden + 15 % Heilung), Magier *Meteor* (Einschlag nach 0,9 s), Schurke *Klingentanz* (3 Schläge rundherum).

**Wiedergeburt** (Charakter → Aufstieg, ab Level 50, max. Stufe 10): Level startet bei 1, dauerhaft +6 % Leben/Schaden und +10 % XP je Stufe, dazu Gold, Essenz und eine legendäre Ausrüstung. Dort auch der **Klassenwechsel** (750 Gold).

**Raid „Weltenfresser“**: alle ~35 Min für 10 Min in eigener Arena (Admin: Button „Raid jetzt starten“). Mehr Helden = mehr Boss-Leben. Beute nach Schadensanteil (Platz 1 meist Legendär, Top 3 Episch), max. 5 Tode je Raid.

**Saison** (monatlich, UTC): Punkte aus Quests, Bossen, Tresoren, Geheimräumen, Arena und vor allem dem Raid. Zum Monatswechsel Belohnung nach Stufe (Bronze/Silber/Gold/Diamant), Punkte starten neu, Top 10 im Reiter „Saison“.

Neue Account-Felder in MongoDB: `keys`, `prestige`, `season {id, points}`; neue Stats: `vaults`, `secrets`, `raidKills`.
