import { createRoot } from "react-dom/client";
import { WorkApp } from "./board/WorkApp";
import "./assets/main.css";

// Follow the system's light or dark appearance, as Orca does.
const scheme = window.matchMedia("(prefers-color-scheme: dark)");
const applyScheme = () => document.documentElement.classList.toggle("dark", scheme.matches);
applyScheme();
scheme.addEventListener("change", applyScheme);

createRoot(document.getElementById("root")!).render(<WorkApp />);
