# Wird Word

A turn-based story game: players take turns adding **one word at a time** to a shared story, by typing it or saying it into the microphone. Play with 2 to 4 people in a room, and add Gemini players if you're short on humans.

## Run

```sh
cp .env.example .env   # set DATABASE_URL (Postgres, e.g. Neon) and optionally GEMINI_API_KEY
npm install
npm start              # http://localhost:3000, applies schema.sql on start
```

Node 22+. The only dependency is `pg`.

## How it plays

- Create an account with a username and password, or log in. Accounts work on any device.
- Create a room or join one by code or invite link.
- The host can add Gemini players and starts the game.
- Turns rotate through the players in join order. On your turn, type a single word (spaces are blocked) or tap the mic and say it.
- Every word shows up live for everyone, colored by player, and can be read aloud (text to speech).

## Notes

- Users, rooms, players and every word are saved in Postgres as they happen, so games survive restarts and can be resumed days later. Log in on any device to pick your games up. The lobby lists your games and flags the ones where it is your turn.
- Closing the app keeps your seat; tapping Leave gives it up. A room is deleted when its last human leaves.
- Passwords are hashed with scrypt; each device gets its own session token (only its hash is stored). Repeated wrong passwords for a username are throttled.
- The mic uses the browser's Web Speech API: it works in Chrome, Edge and Safari, and only on `https://` or `localhost`.
- `GEMINI_MODEL` defaults to `gemini-flash-lite-latest` (fast), with `GEMINI_FALLBACK_MODEL` (`gemini-flash-latest`) tried when it fails.

