import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import App from "./App"
import { GlobalTaskProvider } from "./globalTask"
import "./styles.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GlobalTaskProvider>
      <App />
    </GlobalTaskProvider>
  </StrictMode>,
)
