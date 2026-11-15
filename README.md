# IDManager for Steam

Portable Windows app (Electron) for Steam custom profile IDs (`steamcommunity.com/id/<name>`):

- **Swapper** – moves the custom ID of account 1 to account 2 as fast as possible; the checks come only after the move.
- **Account manager** – keeps accounts in `accounts.txt`, reads each account's SteamID64 and current custom ID, exports/imports an encrypted config (`.vsa`).
- **Free ID search** – checks IDs from `ids.txt`, saves free ones to `available.txt` and claims each with the next account that has no custom ID (`claimed.txt` records who took what).

UI languages: English (default) and Russian.

> Not affiliated with Valve. Automating Steam accounts may break the Steam Subscriber Agreement and can get accounts limited. Use it only with accounts you own, at your own risk.

## Use

Download `IDManager-for-Steam.exe` from the Releases page and run it. No installer. Next to the exe it creates:

| File | Purpose |
|------|---------|
| `accounts.txt` | `login:password` or `login:password:shared_secret`, one per line. **Plain text, do not share.** |
| `accounts_info.json` | what the app learned (SteamID64, custom ID); no passwords |
| `ids.txt` | IDs to look for (one per line or comma separated; case is kept) |
| `available.txt` | free IDs found |
| `claimed.txt` | `ID:login` of claimed IDs |

Swap accounts 1 and 2 typed into the Swapper card are kept in memory only.
The config export is AES-256-GCM with a scrypt key; the password needs 5+ characters, a digit and a capital letter.

Windows SmartScreen or an antivirus may warn: the exe is not code-signed.

## Build

```bash
npm install
npm test          # offline tests against a fake Steam
npm start         # run from source
npm run build     # dist/IDManager-for-Steam.exe (portable)
```

**Update** compares the latest GitHub release tag with the app version and opens the release page when a newer one exists (nothing is replaced automatically). The check also runs at start; switch it off with the checkbox at the bottom of the window. The repository address is the `REPO` constant in `main.js`. Releases are tagged `vX.Y.Z`, matching `version` in `package.json`.

## Known issues

- `npm audit` reports vulnerabilities in old transitive dependencies of `steamcommunity` / `steam-user` (`request`, `cheerio 0.22`, `protobufjs`, …). The app only talks to Steam, but keep it in mind.
- Steam sometimes answers "An error occurred while setting account details" even when the change went through; the app re-reads the profile to find out the real result.
- Tested against a mock of Steam; real Steam behaviour (limits, throttling) can differ.

## License

MIT, see [LICENSE](LICENSE).

---

# IDManager for Steam (по-русски)

Портативное приложение для Windows (Electron) для кастомных ID профиля Steam:

- **Swapper** – переносит ID аккаунта 1 на аккаунт 2 как можно быстрее; проверки делаются только после переноса.
- **Менеджер аккаунтов** – хранит аккаунты в `accounts.txt`, читает SteamID64 и текущий ID, экспортирует/импортирует зашифрованный конфиг (`.vsa`).
- **Поиск свободных ID** – проверяет ID из `ids.txt`, свободные пишет в `available.txt` и занимает следующим аккаунтом без своего ID (`claimed.txt` – кто что занял).

> Проект не связан с Valve. Автоматизация аккаунтов может нарушать Соглашение подписчика Steam и привести к ограничениям. Используйте только свои аккаунты и на свой риск.

Скачайте `IDManager-for-Steam.exe` из Releases и запустите. Файлы данных создаются рядом с exe; `accounts.txt` хранится открытым текстом, не передавайте его. Пароли аккаунтов 1 и 2 из карточки Swapper живут только в памяти. Пароль конфига: от 5 символов, с цифрой и заглавной буквой. SmartScreen/антивирус могут ругаться: exe не подписан.

Сборка: `npm install`, `npm test`, `npm run build`. Кнопка «Обновление» сравнивает тег последнего релиза на GitHub с версией программы и открывает страницу релиза, если есть новее (автозамены нет); проверка идёт и при запуске, отключается галочкой внизу окна. Адрес репозитория – константа `REPO` в `main.js`.

Лицензия: MIT, см. [LICENSE](LICENSE).
