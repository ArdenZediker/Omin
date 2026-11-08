import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CodexPetPackage } from "../app/pets/codexPetTypes";
import DesktopPet from "./DesktopPet";

const packageData: CodexPetPackage = {
  id: "extended-pet",
  displayName: "Extended Pet",
  description: "",
  spritesheetPath: "spritesheet.png",
  spritesheetWebPath: "/pets/extended-pet/spritesheet.png",
  packageDir: "D:/pets/extended-pet",
  manifestPath: "D:/pets/extended-pet/pet.json",
  spritesheetExists: true,
  source: "custom",
};

describe("DesktopPet", () => {
  it("atlas 高度跟随贴图原始比例，不按固定 9 行拉伸", () => {
    const { container } = render(
      <DesktopPet width={54} height={54} state="idle" packageData={packageData} />,
    );

    const viewport = container.querySelector<HTMLElement>(".desktop-pet__viewport");
    const atlas = container.querySelector<HTMLImageElement>(".desktop-pet__atlas");

    expect(viewport?.style.width).toBe("50px");
    expect(viewport?.style.height).toBe("54px");
    expect(atlas?.style.width).toBe("400px");
    expect(atlas?.style.height).toBe("auto");
  });
});
