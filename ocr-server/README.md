# OCR Service (Pix2Text)

Local OCR sidecar for SiYuan PDF × Zotero.

## Layout

```text
ocr-server/
  runtime/python.exe       bundled Python (portable build only)
  models/                  local Pix2Text/CnOCR/CnSTD models
  pz_ocr_server.py         HTTP service
  config.json              host/port/device/languages
  start.bat                Windows launcher
```

Default port: `8891`.

## API

```text
GET  /health
POST /ocr
```

`/ocr` request:

```json
{
  "imageBase64": "...",
  "mode": "auto",
  "source": "pdf-region",
  "languages": ["zh", "en"],
  "formulaFormat": "inline"
}
```

## Development run

```powershell
python -m pip install -r requirements.txt
python pz_ocr_server.py 8891
```

First Pix2Text use may download models to the user's Pix2Text/CnOCR/CnSTD cache directory. For an offline portable build, copy the model cache into `models/` and configure the local model paths in `config.json`.

## Notes

- This repository currently contains the service skeleton, not the multi-hundred-MB model files.
- The plugin can still detect whether the service is running and show model/import errors through `/health`.
- OCR files stay local; no image is uploaded to a remote service.
