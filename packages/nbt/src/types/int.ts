import { BinaryStream, Endianness } from "@serenityjs/binarystream";

import { TagType } from "../enum";

import { BaseTag } from "./base-tag";
import { ReadWriteOptions } from "./read-write-options";

class IntTag extends Number implements BaseTag {
  public readonly type = TagType.Int;

  public name: string | null;

  /**
   * Create a new IntTag instance.
   * @param value The int value.
   * @param name The name of the tag, defaults to null.
   */
  public constructor(value: number, name?: string | null) {
    super(value);
    this.name = name ?? null;
  }

  public toJSON(): number {
    // Convert the short value to a JSON number.
    return this.valueOf();
  }

  public static read(
    stream: BinaryStream,
    options: ReadWriteOptions = { name: true, type: true, varint: false }
  ): IntTag {
    // Check if the tag type is expected.
    if (options?.type) {
      // Read the tag type.
      const type: TagType = stream.readInt8();

      // Verify that the tag type matches the expected type.
      if (type !== TagType.Int) {
        // Throw an error if the type does not match.
        throw new Error(
          `Expected tag type to be ${TagType[TagType.Int]}, received ${TagType[type] ?? type}.`
        );
      }
    }

    // Prepare a variable to hold the name of the tag.
    let name: string | null = null;

    // Check if the tag name is expected.
    if (options?.name) {
      // Read the length of the name based on the varint option.
      const length = options?.varint
        ? stream.readVarInt()
        : stream.readInt16(Endianness.Little);

      // Read the name from the stream.
      const buffer = stream.readBuffer(length);

      // Convert the buffer to a string.
      name = buffer.toString("utf8");
    }

    // Read the int value from the stream.
    const value = options?.varint
      ? stream.readZigZag()
      : stream.readInt32(Endianness.Little);

    // Create and return a new IntTag instance.
    return new this(value, name);
  }

  public static write(
    stream: BinaryStream,
    value: IntTag,
    options: ReadWriteOptions = { name: true, type: true, varint: false }
  ): void {
    // Check if the tag type should be written.
    if (options?.type) stream.writeInt8(value.type);

    // Check if the tag name should be written.
    if (options?.name) {
      // Convert the name to a buffer.
      const buffer = Buffer.from(value.name ?? "", "utf8");

      // Write the length of the name based on the varint option.
      if (options.varint) stream.writeVarInt(buffer.length);
      else stream.writeInt16(buffer.length, Endianness.Little);

      // Write the name buffer to the stream.
      stream.writeBuffer(buffer);
    }

    // Write the int value to the stream.
    if (options?.varint) stream.writeZigZag(value.valueOf());
    else stream.writeInt32(value.valueOf(), Endianness.Little);
  }
}

export { IntTag };
