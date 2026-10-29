// Find the page elements used by the chatbot.
const chatForm = document.querySelector("#chat-form");
const messageInput = document.querySelector("#message-input");
const sendButton = document.querySelector(".send-button");
const messages = document.querySelector("#messages");
const quickButtons = document.querySelectorAll(".quick-button");
const demoModeToggle = document.querySelector("#demo-mode");
const demoStatus = document.querySelector("#demo-status");

// Demo Mode starts on for presentations. This setting lives only in this page
// session and uses a sample location instead of requesting browser location.
const DEMO_LOCATION = {
  latitude: 33.1507,
  longitude: -96.8236,
};

// Load the same labels and keywords used by the server. Retry on the next
// message if the endpoint is temporarily unavailable.
let amenityDefinitions;
let nearbyPattern;
async function loadAmenities() {
  if (amenityDefinitions) return;
  const response = await fetch("/api/amenities");
  if (!response.ok) throw new Error("Could not load supported amenities. Please try again.");
  const data = await response.json();
  if (!data.amenities || typeof data.amenities !== "object" || typeof data.nearbyPattern !== "string") {
    throw new Error("The amenity list was unreadable. Please try again.");
  }
  nearbyPattern = new RegExp(data.nearbyPattern, "i");
  amenityDefinitions = data.amenities;
}

// This flag prevents a second request while the first one is running.
let isLoading = false;

// Give Walnut's replies a mascot and name. The image is decorative because
// the visible name already identifies who is speaking.
function addWalnutAvatar(message) {
  const avatar = document.createElement("img");
  avatar.className = "walnut-avatar";
  avatar.src = "assets/walnut.png";
  avatar.alt = "";
  const name = document.createElement("span");
  name.className = "assistant-name";
  name.textContent = "Walnut";
  message.append(avatar, name);
}

// Add a message bubble to the chat area.
function addMessage(text, sender, results, source, distanceNote) {
  const message = document.createElement("div");
  const paragraph = document.createElement("p");

  message.classList.add("message", `${sender}-message`);
  if (sender === "assistant") {
    addWalnutAvatar(message);
  }
  paragraph.textContent = text;
  message.appendChild(paragraph);

  if (sender === "assistant" && Array.isArray(results) && results.length > 0) {
    message.classList.add("message-with-results");
    addResultCards(message, results);
  }

  // Show attribution quietly below the cards, including for empty GIS results.
  if (sender === "assistant" && source) {
    const footer = document.createElement("p");
    footer.className = "response-footer";
    footer.textContent = [`Source: ${source}`, distanceNote].filter(Boolean).join(" · ");
    message.appendChild(footer);
  }

  messages.appendChild(message);
  messages.scrollTop = messages.scrollHeight;
}

// Show each GIS result without allowing data to become HTML.
function addResultCards(message, results) {
  const resultList = document.createElement("div");
  resultList.className = "result-list";

  results.forEach(function (result) {
    const card = document.createElement("article");
    const title = document.createElement("h3");
    const details = document.createElement("p");

    card.className = "result-card";
    title.textContent = result.park || result.name || "Frisco facility";
    details.textContent = [
      result.facilityType ? `Type: ${amenityDefinitions?.[result.facilityType]?.singular || result.facilityType}` : "",
      result.address ? `Address: ${result.address}` : "Address: Not available",
      Number.isFinite(result.distanceMiles)
        ? `Distance: ${result.distanceMiles} miles`
        : "",
    ]
      .filter(Boolean)
      .join(" • ");

    card.appendChild(title);
    card.appendChild(details);

    if (result.website) {
      const website = document.createElement("a");
      website.href = result.website;
      website.target = "_blank";
      website.rel = "noopener noreferrer";
      website.textContent = "Visit park website";
      card.appendChild(website);
    }

    resultList.appendChild(card);
  });

  message.appendChild(resultList);
}

function addLoadingMessage() {
  const loadingMessage = document.createElement("div");
  loadingMessage.className = "message assistant-message loading-message";
  loadingMessage.setAttribute("aria-live", "polite");
  addWalnutAvatar(loadingMessage);
  const status = document.createElement("p");
  status.textContent = "Searching for Frisco facilities…";
  loadingMessage.appendChild(status);
  messages.appendChild(loadingMessage);
  messages.scrollTop = messages.scrollHeight;
  return loadingMessage;
}

// Nearby facility questions need the browser's current position.
function questionNeedsLocation(text) {
  const question = text.toLowerCase();
  const mentionsNearby = nearbyPattern.test(question);
  const asksAboutSupportedFacility = Object.values(amenityDefinitions || {}).some(
    (amenity) => amenity.keywords.some((keyword) => question.includes(keyword.toLowerCase()))
  );

  return mentionsNearby ||
    (asksAboutSupportedFacility && /\b(find|where|somewhere)\b/.test(question));
}

function getBrowserLocation() {
  return new Promise(function (resolve, reject) {
    // Demo Mode keeps the sample coordinates internal; they are never shown.
    if (demoModeToggle.checked) {
      resolve(DEMO_LOCATION);
      return;
    }

    if (!navigator.geolocation) {
      reject(new Error("Location services are not available in this browser."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      function (position) {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      },
      function (error) {
        if (error.code === error.PERMISSION_DENIED) {
          reject(
            new Error(
              "No problem — location permission was not granted. Please allow location access to find nearby facilities."
            )
          );
          return;
        }

        reject(
          new Error("I couldn’t get your location right now. Please try again.")
        );
      }
    );
  });
}

function updateDemoStatus() {
  demoStatus.hidden = !demoModeToggle.checked;
}

async function askChatApi(message, location) {
  // Non-location questions still need valid coordinates because the existing
  // API contract validates them. These neutral coordinates are never shown or
  // used for a facility search unless the question is location-related.
  const payload = {
    message,
    latitude: location ? location.latitude : 0,
    longitude: location ? location.longitude : 0,
  };
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let data;

  try {
    data = await response.json();
  } catch (error) {
    throw new Error("The assistant returned an unreadable response.");
  }

  if (!response.ok || data.error) {
    throw new Error(
      data.error || "The assistant could not complete that request."
    );
  }

  return data;
}

function setLoadingState(loading) {
  isLoading = loading;
  messageInput.disabled = loading;
  sendButton.disabled = loading;
  quickButtons.forEach(function (button) {
    button.disabled = loading;
  });
  sendButton.textContent = loading ? "Sending…" : "Send";
}

async function sendMessage(text) {
  const cleanText = text.trim();

  if (isLoading || cleanText === "") {
    return;
  }

  addMessage(cleanText, "user");
  messageInput.value = "";
  setLoadingState(true);
  const loadingMessage = addLoadingMessage();

  try {
    await loadAmenities();
    const location = questionNeedsLocation(cleanText)
      ? await getBrowserLocation()
      : null;
    const data = await askChatApi(cleanText, location);

    loadingMessage.remove();
    addMessage(
      data.reply || "I could not find a response for that request.",
      "assistant",
      data.results,
      data.source,
      data.distanceNote
    );
  } catch (error) {
    loadingMessage.remove();
    addMessage(error.message, "assistant");
  } finally {
    setLoadingState(false);
    messageInput.focus();
  }
}

// Form submission supports clicking Send and pressing Enter in the input.
chatForm.addEventListener("submit", function (event) {
  event.preventDefault();
  sendMessage(messageInput.value);
});

// Example chips use the same path as typed messages.
quickButtons.forEach(function (button) {
  button.addEventListener("click", function () {
    sendMessage(button.dataset.question);
  });
});

demoModeToggle.addEventListener("change", updateDemoStatus);
updateDemoStatus();
