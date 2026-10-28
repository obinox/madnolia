import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import App from "./App"
import { GlobalTaskProvider } from "./globalTask"
import "./styles.css"

const root = createRoot(document.getElementById("root")!)

void import("./components/BrowserWorkspace").then(({ BrowserWorkspace }) => {
  root.render(
    <StrictMode>
      <GlobalTaskProvider>
        <BrowserWorkspace>
          <App />
        </BrowserWorkspace>
      </GlobalTaskProvider>
    </StrictMode>,
  )
})
