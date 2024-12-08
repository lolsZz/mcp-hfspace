import {
  EmbeddedResource,
  ImageContent,
  TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import { ApiReturn } from "./gradio_api.js";
import * as fs from "fs/promises";
import { pathToFileURL } from "url";
import path from "path";
import { config } from "./config.js";
import { SpaceInfo } from "./endpoint_wrapper.js";

// Simple converter registry
type ContentConverter = (
  component: ApiReturn,
  value: any,
  spaceInfo: SpaceInfo
) => Promise<TextContent | ImageContent | EmbeddedResource>;

// Type for converter functions that may not succeed
type ConverterFn = (
  component: ApiReturn,
  value: any,
  spaceInfo: SpaceInfo
) => Promise<TextContent | ImageContent | EmbeddedResource | null>;
// Default converter implementation
const defaultConverter: ConverterFn = async () => null;

export class GradioConverter {
  private static converters: Map<string, ContentConverter> = new Map();

  static register(component: string, converter: ContentConverter) {
    this.converters.set(component, converter);
  }

  static async convert(
    component: ApiReturn,
    value: any,
    spaceInfo: SpaceInfo
  ): Promise<TextContent | ImageContent | EmbeddedResource> {
    if (config.debug) {
      await fs.writeFile(generateFilename("debug","json",spaceInfo.spaceName), JSON.stringify(value,null,2));
    }
    const converter =
      this.converters.get(component.component) ||
      withFallback(defaultConverter);
    return converter(component, value, spaceInfo);
  }
}

// Shared text content creator
const createTextContent = (component: ApiReturn, value: any): TextContent => {
  const label = component.label ? `${component.label}: ` : "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return {
    type: "text",
    text: `${label}${text}`,
  };
};

// Wrapper that adds fallback behavior
const withFallback = (converter: ConverterFn): ContentConverter => {
  return async (component: ApiReturn, value: any, spaceInfo: SpaceInfo) => {
    const result = await converter(component, value, spaceInfo);
    return result ?? createTextContent(component, value);
  };
};

// Add these helper functions before convertUrlToBase64
const isImageMimeType = (mimeType: string) => mimeType.startsWith("image/");
const isAudioMimeType = (mimeType: string) => mimeType.startsWith("audio/");

// Update generateFilename to use space name
const generateFilename = (
  prefix: string,
  extension: string,
  spaceName: string
): string => {
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const randomId = crypto.randomUUID().slice(0, 5); // First 5 chars
  const safeSpaceName = spaceName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${date}_${safeSpaceName}_${prefix}_${randomId}.${extension}`;
};

const getExtensionFromFilename = (url: string): string | null => {
  const match = url.match(/\/([^/?#]+)[^/]*$/);
  if (match && match[1].includes('.')) {
    return match[1].split('.').pop() || null;
  }
  return null;
};

const getMimeTypeFromOriginalName = (origName: string): string | null => {
  const extension = origName.split('.').pop()?.toLowerCase();
  if (!extension) return null;
  
  // Common image formats
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(extension)) {
    return `image/${extension}`;
  }
  
  // Common audio formats
  if (['mp3', 'wav', 'ogg', 'aac', 'm4a'].includes(extension)) {
    return `audio/${extension}`;
  }
  
  // For unknown types, fall back to application/*
  return `application/${extension}`;
};

const determineMimeType = (value: any, responseHeaders: Headers): string => {
  // First priority: mime_type from the value object
  if (value?.mime_type) {
    return value.mime_type;
  }

  // Second priority: derived from orig_name
  if (value?.orig_name) {
    const mimeFromName = getMimeTypeFromOriginalName(value.orig_name);
    if (mimeFromName) {
      return mimeFromName;
    }
  }

  // Third priority: response headers
  const headerMimeType = responseHeaders.get("content-type");
  if (headerMimeType && headerMimeType !== 'text/plain') {
    return headerMimeType;
  }

  // Final fallback
  return 'text/plain';
};

const convertUrlToBase64 = async (url: string, value: any) => {
  const headers: HeadersInit = {};
  if (config.hfToken) {
    headers.Authorization = `Bearer ${config.hfToken}`;
  }

  const response = await fetch(url, { headers });
  
  if (!response.ok) {
    throw new Error(
      `Failed to fetch resource: ${response.status} ${response.statusText}`
    );
  }

  const mimeType = determineMimeType(value, response.headers);
  const originalExtension = getExtensionFromFilename(url);
  const arrayBuffer = await response.arrayBuffer();
  const base64Data = Buffer.from(arrayBuffer).toString("base64");
  
  return { mimeType, base64Data, arrayBuffer, originalExtension };
};

// Update saveFile to include space name
const saveFile = async (
  arrayBuffer: ArrayBuffer,
  mimeType: string,
  prefix: string,
  spaceName: string,
  originalExtension?: string | null
): Promise<string> => {
  const extension = originalExtension || mimeType.split("/")[1] || "bin";
  const filename = generateFilename(prefix, extension, spaceName);
  await fs.writeFile(filename, Buffer.from(arrayBuffer), {
    encoding: "binary",
  });
  console.error(`Saved ${prefix} to ${filename}`);
  return filename;
};

// Update converters to use space information
const imageConverter: ConverterFn = async (_component, value, spaceInfo) => {
  if (!value?.url) return null;
  try {
    const { mimeType, base64Data, arrayBuffer, originalExtension } = await convertUrlToBase64(
      value.url,
      value
    );
    await saveFile(arrayBuffer, mimeType, "image", spaceInfo.spaceName, originalExtension);
    return {
      type: "image",
      data: base64Data,
      mimeType,
    };
  } catch (error) {
    console.error("Image conversion failed:", error);
    return {
      type: "text",
      text: `Failed to load image: ${(error as Error).message}`,
    };
  }
};

const audioConverter: ConverterFn = async (_component, value, spaceInfo) => {
  if (!value?.url) return null;
  try {
    const { mimeType, base64Data, arrayBuffer, originalExtension } = await convertUrlToBase64(
      value.url,
      value
    );
    const filename = await saveFile(
      arrayBuffer,
      mimeType,
      "audio",
      spaceInfo.spaceName,
      originalExtension
    );

    if (config.claudeDesktopMode) {
      return {
        type: "resource",
        resource: {
          uri: `${pathToFileURL(path.resolve(filename)).href}`,
          mimetype: `text/plain`,
          text: `Your audio was succesfully created and is available for playback at ${path.resolve(filename)}. Claude Desktop does not currently support audio content`,
        },
      };
    } else {
      return {
        type: "resource",
        resource: {
          uri: `${pathToFileURL(path.resolve(filename)).href}`,
          mimeType,
          blob: base64Data,
        },
      };
    }
  } catch (error) {
    console.error("Audio conversion failed:", error);
    return {
      type: "text",
      text: `Failed to load audio: ${(error as Error).message}`,
    };
  }
};

// Register converters with fallback behavior
GradioConverter.register("Image", withFallback(imageConverter));
GradioConverter.register("Audio", withFallback(audioConverter));
GradioConverter.register(
  "Chatbot",
  withFallback(async () => null)
);
