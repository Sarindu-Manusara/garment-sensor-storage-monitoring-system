import Lottie from "lottie-react";

import chatbotIconAnimation from "../assets/chatbot-icon-lottie.json";

export function ChatbotLottieIcon({ size = 54, loop = true }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flexShrink: 0
      }}
    >
      <Lottie
        animationData={chatbotIconAnimation}
        loop={loop}
        autoplay
        style={{
          width: "100%",
          height: "100%"
        }}
      />
    </div>
  );
}

export default ChatbotLottieIcon;
