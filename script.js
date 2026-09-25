// Find the page elements that the chatbot needs.
const chatForm = document.querySelector("#chat-form");
const messageInput = document.querySelector("#message-input");
const messages = document.querySelector("#messages");
const quickButtons = document.querySelectorAll(".quick-button");

// Add one message bubble to the chat area.
function addMessage(text, sender) {
  const message = document.createElement("div");
  const paragraph = document.createElement("p");

  message.classList.add("message", `${sender}-message`);
  paragraph.textContent = text;
  message.appendChild(paragraph);
  messages.appendChild(message);

  // Move the chat area down so the newest message is visible.
  messages.scrollTop = messages.scrollHeight;
}

// Show a simple Phase 1 reply. No API or backend is used yet.
function answerMessage() {
  addMessage(
    "Thanks for your message! Location results will be available in a future phase.",
    "assistant"
  );
}

// Send a message from either the text box or a quick-action button.
function sendMessage(text) {
  const cleanText = text.trim();

  if (cleanText === "") {
    return;
  }

  addMessage(cleanText, "user");
  answerMessage();
}

chatForm.addEventListener("submit", function (event) {
  event.preventDefault();
  sendMessage(messageInput.value);
  messageInput.value = "";
  messageInput.focus();
});

quickButtons.forEach(function (button) {
  button.addEventListener("click", function () {
    sendMessage(button.dataset.question);
  });
});
