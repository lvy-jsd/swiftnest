import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ThemeProvider } from "./design/theme";
import { I18nProvider } from "./i18n";
import { ConnectionProvider } from './connection';
import "./styles.css";

createRoot(document.getElementById("root")!).render(<StrictMode><ThemeProvider><I18nProvider><ConnectionProvider><App /></ConnectionProvider></I18nProvider></ThemeProvider></StrictMode>);
