# Colors

Browser color tools for [geekahedron.com/tools/colors/](https://geekahedron.com/tools/colors/). Compare two colors, look up names near a target similarity, or solve a Colordle from the guesses you were shown. The page is plain HTML, CSS, and JavaScript in `src/`. There is no build step when the site is served. Paths are relative, so the `src/` folder can be mounted at `/tools/colors/`.

Everything runs in the browser. Nothing is uploaded.

## What it does

- **Compare** places two colors side by side and shows their similarity. A color can be a name (with autocomplete), a hex code (`#abc` or `#aabbcc`), or the value from the color picker. The name, the hex, the picker, and the swatch stay in sync.
- **Target** takes one color, a target similarity percent, and a tolerance. It lists named colors whose similarity to that color is within the tolerance (`find_similar_colors`), sorted by closeness to the target percent.
- **Solve** takes several guesses. Each guess is a color plus the similarity percent you were shown. It lists named colors consistent with every guess within the tolerance (`find_consistent_colors`). Guessed names are left out. Results are sorted by total absolute deviation and show each guess's deviation and the total. The page shows the top 50 and the count of all matches.

Tolerance defaults to 2 and can be set from 0 to 15 in steps of 0.1. Scans run in a web worker so the page stays responsive, and fall back to chunked work on the page if the worker cannot start.

## Formula

The score is `color_similarity` from [`reference/color-finder.pl`](reference/color-finder.pl), ported in [`src/color.js`](src/color.js).

1. Strip `#` and turn the hex into sRGB channels on 0–1 (`channel / 255`).
2. Convert each channel to linear light: `c / 12.92` when `c <= 0.04045`, otherwise `((c + 0.055) / 1.055) ** 2.4`.
3. Convert linear RGB to XYZ with the same matrix as the script:

   ```
   X = 0.4124564 R + 0.3575761 G + 0.1804375 B
   Y = 0.2126729 R + 0.7151522 G + 0.0721750 B
   Z = 0.0193339 R + 0.1191920 G + 0.9503041 B
   ```

4. Convert XYZ to CIE Lab with the D65 white point `(0.95047, 1, 1.08883)` and

   ```
   f(t) = t ** (1/3)                         when t > (6/29) ** 3
   f(t) = (1/3) * (29/6) ** 2 * t + 4/29     otherwise
   L = 116 f(Y/Yn) - 16
   a = 500 (f(X/Xn) - f(Y/Yn))
   b = 200 (f(Y/Yn) - f(Z/Zn))
   ```

5. Take CIEDE2000 (`ΔE00`) exactly as the script's `ciede2000` closure writes it, including its hue-angle adjustment. It does not add the separate `C' = 0` hue special cases found in some other writeups.
6. Turn that distance into a similarity and clamp it:

   ```
   similarity = clamp(100 * (1 - ΔE00 / 100), 0, 100)
   ```

   `ΔE00` of 0 is 100%. `ΔE00` of 100 or more is 0%.

Target search keeps a named color when `abs(similarity - target)` is less than or equal to the tolerance. Solve does the same against every guess, sums the absolute deviations, drops the guessed names, and sorts by that sum. Ties keep the order the names were loaded.

## Data

`src/colors.json` is a compact array of `[name, hex]` pairs. Hex values are uppercase and include `#`. It is built from the CSVs in `reference/`, in this order, which is the order `load_colors` uses:

1. `colornames.csv`
2. `css-x11.csv`
3. `extras.csv` (header only, until extra names are added)

The header row is skipped. A later row is skipped when its lowercased name **or** its uppercased hex was already kept. The first file wins. `extras.csv` is the place to add names without editing the other two lists.

`reference/colornames.csv` matches the [meodai/color-names](https://github.com/meodai/color-names) list: the header is `name,hex,good name`, and rows such as `100 Mph,#c93f38,x`, `À l’Orange,#f2850d,x`, and `Stardew,#a6b2b5` are the same. This copy is a snapshot, not a promise that it is the latest upstream file. Those names are © 2017 David Aerne and used under the MIT License ([`reference/meodai-color-names.LICENSE.txt`](reference/meodai-color-names.LICENSE.txt)). `css-x11.csv` is the CSS/X11 keyword list. Only keywords whose name and hex were both still unused are added (currently Dark Gray, Golden Rod, and Steel Blue).

## Regenerate colors.json

From the repository root, after editing any of the three CSVs:

```bash
node tools/build-colors.js
```

That rewrites `src/colors.json`. Commit the JSON with the CSV change. Serving the site does not run this script.

## Tests

```bash
node --test test/similarity.test.js
```

The reference case is the one in the Perl script and in [`reference/results.txt`](reference/results.txt): guesses White Blue = 90 and Bubblegum = 90, tolerance 8, guessed names removed, sorted by total deviation. The top 10 names, hex values, and deviations must match that file to two decimals. Stardew is first: 0.40 vs White Blue, 3.42 vs Bubblegum, total 3.83.

## Local preview

Module scripts and the worker need HTTP, not `file://`.

```bash
python3 -m http.server 8765 -d src
```

Open `http://127.0.0.1:8765/`. The Solve tab's sample button loads White Blue 90 and Bubblegum 90 at tolerance 8, which is the reference case above. On the deployed site the same files live at `/tools/colors/` and the Geekahedron link (`../../`) points at the site root.
