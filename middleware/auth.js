const jwt = require("jsonwebtoken");

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");

  if (type !== "Bearer" || !token) {
    return res.status(401).json({ ok: false, error: "No autenticado" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;

    // ✅ Log solo en desarrollo
    if (process.env.NODE_ENV !== "production") {
      console.log(
        "AUTH:",
        req.method,
        req.originalUrl,
        "USER:",
        req.user?.user_id
      );
    }

    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Token inválido" });
  }
}

module.exports = { auth };