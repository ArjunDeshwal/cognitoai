# Cognito Website

Simple landing page for Cognito download.

## Hosting Options

### Option 1: GitHub Pages (Recommended)
1. Push this folder to a `gh-pages` branch
2. Enable GitHub Pages in repo settings
3. Access at `https://yourusername.github.io/cognito`

### Option 2: Vercel / Netlify
1. Connect your GitHub repo
2. Set build directory to `website`
3. Deploy automatically on push

### Option 3: Custom Domain
1. Add a `CNAME` file with your domain
2. Configure DNS to point to GitHub Pages
3. Enable HTTPS in repo settings

## Updating Download Links

Edit `index.html` and replace:
- `yourusername` with your GitHub username
- Version numbers when releasing new versions

## Adding Screenshot

Replace the placeholder in the hero section:
```html
<img src="screenshot.png" alt="Cognito Screenshot">
```
