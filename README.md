# Passobot Pro

Two-browser **Passo** seat handover bot (A holds seat -> B grabs same seat) using `puppeteer-real-browser` and AntiCaptcha for Turnstile.

## Quick start

```bash
npm i
cp .env.example .env    # fill in your keys & paths
npm start
```

### Request

`POST /start-bot`

```json
{
  "team": "GS",
  "ticketType": "combined",
  "eventAddress": "https://www.passo.com.tr/tr/etkinlik/....",
  "categoryType": "Kategori 1",
  "alternativeCategory": "Kategori 2",
  "prioritySale": false,
  "fanCardCode": null,
  "identity": null,
  "email": "accountA@mail.com",
  "password": "passA",
  "cardHolder": "NAME SURNAME",
  "cardNumber": "4111 1111 1111 1111",
  "expiryMonth": "12",
  "expiryYear": "29",
  "cvv": "123",
  "proxyHost": null,
  "proxyPort": null,
  "proxyUsername": null,
  "proxyPassword": null,
  "email2": "accountB@mail.com",
  "password2": "passB"
}
```

### Notes

- Keys go to `.env`. Never commit your real AntiCaptcha key.
- `ORDER_LOG_URL` is optional; if set, a POST will be sent after B holds the seat.
- If Cloudflare Turnstile isn't detected within ~7s we solve it via AntiCaptcha and inject the token.

## Layout

```
src/
  index.js            # express bootstrap
  config.js           # env and defaults
  routes/botRoutes.js
  controllers/botController.js
  utils/delay.js
  helpers/
    swal.js           # confirmSwalYes, clickRemoveFromCartAndConfirm
    page.js           # ensurePage, readBasketData, readCatBlock, setCatBlockOnB, openSeatMapStrict, clickContinueInsidePage, captureSeatIdFromNetwork
    seat.js           # pickRandomSeatWithVerify, pickExactSeatWithVerify_Locked
```

## Disclaimer

This is for educational/automation purposes where permitted. Use responsibly and comply with the site's TOS and local laws.
