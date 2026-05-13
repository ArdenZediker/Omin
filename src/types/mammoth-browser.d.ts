declare module "mammoth/mammoth.browser" {
  type MammothResult = {
    value: string;
    messages: Array<unknown>;
  };

  type MammothInput = {
    arrayBuffer: ArrayBuffer;
  };

  type Mammoth = {
    convertToHtml(input: MammothInput): Promise<MammothResult>;
    convertToMarkdown(input: MammothInput): Promise<MammothResult>;
  };

  const mammoth: Mammoth;
  export default mammoth;
}
