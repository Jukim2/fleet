import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/global.css";

// No StrictMode: it double-mounts components, which would spawn each PTY twice.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
