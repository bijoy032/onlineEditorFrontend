# Frontend Environment Setup

Create a `.env` file in `frontend/` for local dev, and set an environment variable on Vercel for production.

Local dev example (`frontend/.env`):

```
VITE_API_URL=http://localhost:5000
```

Vercel project settings → Environment Variables:

- `VITE_API_URL` = `https://your-backend.onrender.com`

This value is used in `src/App.jsx`:

```js
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";
```
