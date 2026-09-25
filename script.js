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

// Show a simple reply for questions that do not need a location.
function answerMessage() {
  addMessage(
    "Thanks for your message! Location results will be available in a future phase.",
    "assistant"
  );
}

// Check whether the question is asking for something close to the user.
function questionNeedsLocation(text) {
  const question = text.toLowerCase();
  const mentionsNearMe = question.includes("near me");
  const mentionsPlace =
    question.includes("basketball court") || question.includes("playground");
  const mentionsNearby = [
    "nearby",
    "nearest",
    "closest",
    "around me",
    "close to me",
  ].some(function (phrase) {
    return question.includes(phrase);
  });

  return mentionsNearMe || (mentionsPlace && mentionsNearby);
}

// Ask the browser for a one-time location. Nothing is saved after this runs.
function requestLocation() {
  if (!navigator.geolocation) {
    addMessage(
      "Location services are not available in this browser. You can still ask a question without using your location.",
      "assistant"
    );
    return;
  }

  navigator.geolocation.getCurrentPosition(
    function (position) {
      // These values exist only inside this callback and are not displayed.
      const temporaryLocation = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      };

      if (
        Number.isFinite(temporaryLocation.latitude) &&
        Number.isFinite(temporaryLocation.longitude)
      ) {
        addMessage("Location received successfully.", "assistant");
      }
    },
    function (error) {
      if (error.code === error.PERMISSION_DENIED) {
        addMessage(
          "No problem — location permission was not granted. You can still ask about Frisco without sharing your location.",
          "assistant"
        );
        return;
      }

      addMessage(
        "I couldn’t get your location right now. Please try again or ask about Frisco without using your location.",
        "assistant"
      );
    }
  );
}

// Send a message from either the text box or a quick-action button.
function sendMessage(text) {
  const cleanText = text.trim();

  if (cleanText === "") {
    return;
  }

  addMessage(cleanText, "user");

  if (questionNeedsLocation(cleanText)) {
    requestLocation();
  } else {
    answerMessage();
  }
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
