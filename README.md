# Sabal Festival Pet Portraits

An iPad kiosk for The Sabal Collection booth. Guests take a free photo with their pet, choose a luxury world, and leave email + phone to receive the portrait.

The look follows the live brand: Tenor Sans, Quattrocento Sans, matte black, cream, and gold, with the real Clove & Smoked Vanilla jar placed into every finished frame.

## On the iPad

1. Open the site in Safari (HTTPS or the Mac serving this folder on the same Wi‑Fi).
2. Share → **Add to Home Screen** so it runs fullscreen.
3. Allow the camera when asked.
4. Set the iPad in a stand facing the aisle. The attract screen is meant to be read from several feet away.

First load needs the internet so MediaPipe can fetch the cutout models. After that, the booth assets stay cached.

## Guest flow

1. **Tap to start**
2. **Snap** — 3-2-1, then the shutter
3. **Choose a world** — six large tiles
4. **Send my photos** — email + phone
5. Auto-returns for the next guest

Tap another world on the reveal screen to restyle the same photo. Tap the gold logo six times for the staff lead list.

## Worlds

| World | Matching scent | Extra clothing |
| --- | --- | --- |
| Winter Fireside | Clove & Smoked Vanilla | Beanie + cream scarf |
| Mykonos Sunset | Mykonos Sunset | Sun hat + sunglasses |
| Autumn Orchard | Toasted Vanilla Pumpkin | Harvest scarf |
| Winter Woods | Winter Woods | Beanie + scarf |
| Champagne Night | Oud & Rose | Sunglasses |
| Holiday Hearth | Holiday Mulled Cider | Festive knits |

People and pets stay real. The background is replaced, a themed wardrobe overlay is added when a face is found, and the Sabal candle is composited into the foreground.

## Run locally

```bash
npm start
```

Then open `http://localhost:4173`. Camera access works on localhost and on HTTPS.

Use `http://localhost:4173/?demo=1` to walk the full flow with a sample guest when a camera is not available.

## Staff / leads

`admin.html` stores every guest in IndexedDB on that iPad: name, email, phone, theme, and the finished JPEG. Download a CSV from there, then email or text the portraits after the festival.

There is no third-party mailer in this repo. The thank-you screen tells guests the photos are on the way; fulfillment is from the admin list.

## Notes

- Keep the iPad plugged in. The app requests a screen wake lock after the first tap.
- After 90 seconds idle it returns to the attract loop.
- If cutout models fail (no network), the booth still builds a feathered oval portrait on the chosen world so the line keeps moving.
