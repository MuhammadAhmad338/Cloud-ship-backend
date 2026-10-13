import { Router } from "express";

const router = Router();

router.get("/", (_request, response) => {
  response.json([
    { name: "Production", protection: "Protected" },
    { name: "Staging", protection: "Approval required" },
    { name: "Development", protection: "Open" },
  ]);
});

export default router;