/* S-Market Place: where the Flask API lives.
   After you deploy the backend on Render, make sure the URL below matches your Render service URL
   exactly (shown at the top of the service page), with no trailing slash. Then commit and redeploy. */
window.SMP_API_BASE_URL = (["localhost", "127.0.0.1"].includes(window.location.hostname))
  ? "http://127.0.0.1:5000"
  : "https://s-market-place-api.onrender.com";
