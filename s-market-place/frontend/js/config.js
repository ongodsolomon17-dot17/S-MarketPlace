/* S-Market Place: where the Flask API lives.
   After you deploy the backend on Render, make sure the URL below matches your Render service URL
   exactly (shown at the top of the service page), with no trailing slash. Then commit and redeploy. */
window.SMP_API_BASE_URL = (["localhost", "127.0.0.1"].includes(window.location.hostname))
  ? "http://127.0.0.1:5000"
  : "https://s-marketplace.onrender.com";

/* CHAT LINK (optional): paste the web address of your chat app here to switch on the "Message" buttons.
   Leave it empty ("") and the buttons say "Coming soon".
   When set, Message opens   <your chat address>?with=<trader username>&from=<your username>
   and the trader's Messages button opens   <your chat address>. Your chat app reads those two values. */
window.SMP_CHAT_URL = "";
