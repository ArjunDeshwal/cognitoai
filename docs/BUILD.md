# Building Cognito for Distribution

## Prerequisites

- Node.js 22.12+
- Python 3.10+

## Build Commands

### Build for Current Platform
```bash
cd app
npm run package
```

### Build for Specific Platform
```bash
# Mac only (creates .dmg and .zip)
npm run package:mac

# Windows only (creates .exe installer)
npm run package:win

# Linux only (creates .AppImage and .deb)
npm run package:linux
```

### Output Location
Built files will be in `app/release/`:
```
release/
├── Cognito-1.0.0-arm64.dmg      # Mac Apple Silicon
├── Cognito-Setup-1.0.0.exe       # Windows Installer
├── Cognito-1.0.0-portable.exe    # Windows Portable
├── Cognito-1.0.0.AppImage        # Linux
└── cognito_1.0.0_amd64.deb       # Debian/Ubuntu
```

## Creating App Icons

You need to create icons in these formats:
- `app/assets/icon.icns` - Mac (1024x1024)
- `app/assets/icon.ico` - Windows (256x256)
- `app/assets/icon.png` - Linux (512x512)

Use a tool like:
- https://www.npmjs.com/package/electron-icon-builder
- https://iconverticons.com/online/

## Publishing to GitHub Releases

1. Build all platforms
2. Go to GitHub > Releases > Create new release
3. Tag version (e.g., `v1.0.0`)
4. Upload all files from `release/` folder
5. Publish release

## Important Notes

### Python Backend
Release builds bundle the FastAPI backend as a standalone PyInstaller executable. End users do not need Python or pip. Developers still need Python 3.10+ when running from source.

### Code Signing
Code signing and macOS notarization are required for a trustworthy production release:
- Mac: Apple Developer certificate ($99/year)
- Windows: Code signing certificate (~$100-300/year)

Unsigned development builds will show:
- Mac: "Cannot be opened because developer cannot be verified"
- Windows: "Windows protected your PC" warning
