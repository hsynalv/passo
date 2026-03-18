# SVG Blok Yapısı ve Kullanım

## Passo SVG Yapısı

SVG bloklarında kategori adı (örn. "GÜNEY KALE ARKASI ALT") **yoktur**. Sadece sayısal ID'ler vardır:

```html
<g class="block" id="block17363">...</g>
<g class="block" id="block18339">...</g>
<g class="block" id="block38371">...</g>
```

## Belirli Blok Seçimi (svg modda)

`categoryType` ve `alternativeCategory` ile blok seç (payload değişmez):

```json
{
  "categorySelectionMode": "svg",
  "categoryType": "block17363",
  "alternativeCategory": "block18339"
}
```

veya sadece sayı:

```json
{
  "categorySelectionMode": "svg",
  "categoryType": "17363",
  "alternativeCategory": "18339"
}
```

Önce categoryType, bulunamazsa alternativeCategory denenir.

## Blok ID'lerini Bulma

1. Etkinlik sayfasında "Kendim seçmek istiyorum" tıkla
2. Stadyum haritası açıldığında DevTools (F12) → Elements
3. `svg.svgLayout` içindeki `g.block` elementlerine bak
4. Her blokta `id="block17363"` gibi ID var – bu değeri categoryType/alternativeCategory olarak kullan

Örnek blok listesi:
- block17363, block18339, block38371, block38855, block38851...
- block17851, block17852, block17858, block17859, block17860...
