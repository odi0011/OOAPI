import React from "react";
import { Navigate } from "react-router-dom";
import { useApp } from "../context/AppContext";
export default function AppearancePage() {
  const { user } = useApp();
  return <Navigate replace to={Number(user?.role) >= 100 ? "/admin/settings?tab=appearance" : "/console"} />;
}
