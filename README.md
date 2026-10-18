# ScreenShield editor

Tool local pentru pozele produselor: trasezi conturul displayului, iar tool-ul generează
imaginea satin, cea lucioasă și diagrama, apoi le urcă pe produsele din Shopify.

    npm install
    npm start                 # http://localhost:3847   (BRAND=toyota pentru alt brand)
    npm run upload            # simulare, nu modifică nimic
    npm run upload -- --go    # urcă/creează produse în Shopify (rămân DRAFT)

Date per brand: `data/<brand>/products.json` (lista), `src/` (poze sursă), `work/` (contur + imagini generate).
Prețul din `products.json` este prețul Mat; Lucios este cu 10 lei mai ieftin.
Urcarea folosește Shopify CLI deja autentificat pe magazin.
