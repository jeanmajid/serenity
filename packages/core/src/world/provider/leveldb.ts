import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";

import { BinaryStream, Endianness } from "@serenityjs/binarystream";
import { Leveldb } from "@serenityjs/leveldb";
import { BlockPosition, DimensionType } from "@serenityjs/protocol";
import { CompoundTag } from "@serenityjs/nbt";

import { Chunk, SubChunk } from "../chunk";
import { Dimension } from "../dimension";
import { Serenity } from "../../serenity";
import {
  BlockEntry,
  DimensionProperties,
  EntityEntry,
  PlayerEntry,
  WorldProperties,
  WorldProviderProperties
} from "../../types";
import { World } from "../world";
import { Entity } from "../../entity";
import { ChunkReadySignal, WorldInitializeSignal } from "../../events";
import { Block } from "../../block";
import { Structure } from "../structure";

import { WorldProvider } from "./provider";

class LevelDBProvider extends WorldProvider {
  public static readonly identifier: string = "leveldb";

  /**
   * The path of the provider.
   */
  public readonly path: string;

  /**
   * The database instance for the provider.
   */
  public readonly db: Leveldb;

  /**
   * The loaded chunks in the provider.
   */
  public readonly chunks = new Map<Dimension, Map<bigint, Chunk>>();

  public constructor(path: string) {
    super();

    // Set the path of the provider.
    this.path = path;

    // Open the database for the provider
    this.db = Leveldb.open(resolve(path, "db"));
  }

  public onShutdown(): void {
    // Save all the world data.
    this.onSave();

    // Close the database connection.
    this.db.close();
  }

  public onStartup(): void {
    // Iterate through the dimensions and load the entities.
    for (const dimension of this.world.dimensions.values()) {
      // Get the available entities & blocks for the dimension.
      const entities = this.readAvailableEntities(dimension);
      const blocks = this.readAvailableBlocks(dimension);

      // Check if the entities are empty.
      if (entities.length === 0 && blocks.length === 0) continue;

      // Iterate through the entities and load them.
      for (const uniqueId of entities) {
        // Attempt to read the entity from the database.
        try {
          // Read the entity from the database.
          const entry = this.readEntity(uniqueId, dimension);

          // Create a new entity instance.
          const entity = new Entity(dimension, entry.identifier, {
            uniqueId,
            entry
          });

          // Add the entity to the dimension.
          entity.spawn();
        } catch (reason) {
          // Log the error if the entity failed to load.
          this.world.logger.debug(
            `Failed to load entity with unique id ${uniqueId} for dimension ${dimension.identifier}. Reason:`,
            reason
          );
        }
      }

      // Iterate through the blocks and load them.
      for (const position of blocks) {
        // Attempt to read the block from the database.
        try {
          // Read the block from the database.
          const entry = this.readBlock(position, dimension);

          // Create a new block instance.
          const block = new Block(
            dimension,
            new BlockPosition(...entry.position),
            { entry }
          );

          // Add the block to the dimension blocks collection.
          dimension.blocks.set(BlockPosition.hash(block.position), block);
        } catch (reason) {
          // Separate the position into x, y, and z coordinates.
          const { x, y, z } = position;

          // Log the error if the block failed to load.
          this.world.logger.debug(
            `Failed to load block from position (${x}, ${y}, ${z}) for dimension ${dimension.identifier}. Reason:`,
            reason
          );
        }
      }
    }
  }

  public onSave(): void {
    // Save the world properties to the world directory.
    // First we need to get all the dimension properties.
    const dimensions: Array<DimensionProperties> = [
      ...this.world.dimensions.values()
    ].map((dimension) => dimension.properties);

    // Get the world properties.
    const properties = this.world.properties;
    properties.dimensions = dimensions;

    // Write the properties to the world directory.
    writeFileSync(
      resolve(this.path, "properties.json"),
      JSON.stringify(properties, null, 2)
    );

    // Iterate through the chunks and write them to the database.
    for (const [dimension, chunks] of this.chunks) {
      let savedChunks = 0;
      let savedEntities = 0;
      let savedBlocks = 0;

      // Iterate through the chunks and write them to the database.
      for (const [, chunk] of chunks) {
        // Check if the chunk is dirty.
        if (!chunk.dirty) continue;

        // Attempt to write the chunk to the database.
        try {
          // Write the chunk to the database.
          this.writeChunk(chunk, dimension);

          // Increment the saved chunks count.
          savedChunks++;
        } catch (reason) {
          // Log the error if the chunk failed to save.
          this.world.logger.error(
            `Failed to save chunk at position ${chunk.x}, ${chunk.z} for dimension ${dimension.identifier}. Reason:`,
            reason
          );
        }
      }

      // Iterate through the entities and write them to the database.
      const uniqueIds: Array<bigint> = [];
      for (const [uniqueId, entity] of dimension.entities) {
        // Attempt to write the entity to the database.
        try {
          // Check if the entity is a player.
          if (entity.isPlayer()) {
            // Write the player to the database.
            this.writePlayer(entity.getDataEntry(), dimension);
          } else {
            // Write the entity to the database.
            this.writeEntity(entity.getDataEntry(), dimension);

            // Add the unique identifier to the list.
            uniqueIds.push(uniqueId);
          }

          // Increment the saved entities count.
          savedEntities++;
        } catch (reason) {
          // Log the error if the entity failed to save.
          this.world.logger.error(
            `Failed to save entity with unique id ${uniqueId} for dimension ${dimension.identifier}. Reason:`,
            reason
          );
        }
      }

      // Write the available entities to the database.
      this.writeAvailableEntities(dimension, uniqueIds);

      // Iterate through the blocks and write them to the database.
      const positions: Array<BlockPosition> = [];
      for (const [hash, block] of dimension.blocks) {
        // Attempt to write the block to the database.
        try {
          // Write the block to the database.
          this.writeBlock(block.getDataEntry(), dimension);

          // Add the block position hash to the list.
          positions.push(block.position);

          // Increment the saved blocks count.
          savedBlocks++;
        } catch (reason) {
          // Log the error if the block failed to save.
          this.world.logger.error(
            `Failed to save block at position ${BlockPosition.unhash(
              hash
            )} for dimension ${dimension.identifier}. Reason:`,
            reason
          );
        }
      }

      // Write the available blocks to the database.
      this.writeAvailableBlocks(dimension, positions);

      // Log the amount of chunks, entities, and blocks saved.
      this.world.logger.info(
        `Saved §c${savedChunks}§r chunks, §c${savedEntities}§r entities, and §c${savedBlocks}§r blocks for dimension §a${dimension.identifier}§r.`
      );
    }

    // Flush the database to ensure all data is written.
    return this.db.flush();
  }

  public readBuffer(key: string): Buffer {
    return this.db.get(Buffer.from(key));
  }

  public writeBuffer(key: string, value: Buffer): void {
    this.db.put(Buffer.from(key), value);
  }

  public async readChunk(chunk: Chunk, dimension: Dimension): Promise<Chunk> {
    // Check if the chunks contain the dimension.
    if (!this.chunks.has(dimension)) {
      this.chunks.set(dimension, new Map());
    }

    // Get the dimension chunks.
    const chunks = this.chunks.get(dimension) as Map<bigint, Chunk>;

    // Check if the cache contains the chunk.
    if (chunks.has(chunk.hash)) return chunks.get(chunk.hash) as Chunk;
    // Check if the leveldb contains the chunk.
    else if (this.hasChunk(chunk.x, chunk.z, dimension)) {
      for (let i = 0; i < Chunk.MAX_SUB_CHUNKS; i++) {
        // Prepare an offset variable.
        // This is used to adjust the index for overworld dimensions.
        let offset = 0;

        // Check if the dimension type is overworld.
        if (chunk.type === DimensionType.Overworld) offset = 4; // Adjust index for overworld

        // Calculate the subchunk Y coordinate.
        const cy = i - offset;

        // Read the subchunk from the database.
        const subchunk = this.readSubChunk(chunk.x, cy, chunk.z, dimension);

        // Check if the subchunk is empty.
        if (subchunk.isEmpty()) continue;

        // Push the subchunk to the chunk.
        chunk.subchunks[i] = subchunk;
      }

      // Set the chunk as ready.
      chunk.ready = true;

      // Add the chunk to the cache.
      chunks.set(chunk.hash, chunk);

      // Return the chunk.
      return chunk;
    } else {
      // Generate a new chunk if it does not exist.
      const resultant = await dimension.generator.apply(chunk.x, chunk.z);

      // Add the chunk to the cache.
      chunks.set(chunk.hash, chunk.insert(resultant));

      // Check if the chunk is ready.
      // If so, emit a new ChunkReadySignal.
      if (chunk.ready) new ChunkReadySignal(dimension, chunk).emit();

      // Return the generated chunk.
      return chunk;
    }
  }

  public async writeChunk(chunk: Chunk, dimension: Dimension): Promise<void> {
    // Check if the chunk is empty.
    if (chunk.isEmpty() || !chunk.dirty) return;

    // Write the chunk version, in this case will be 40
    this.writeChunkVersion(chunk.x, chunk.z, dimension, 40);

    // Iterate through the chunks and write them to the database.
    // TODO: Dimensions can have a data driven min and max subchunk value, we should use that.
    for (let cy = 0; cy < Chunk.MAX_SUB_CHUNKS; cy++) {
      // Prepare an offset variable.
      // This is used to adjust the index for overworld dimensions.
      let offset = 0;

      // Check if the dimension type is overworld.
      if (chunk.type === DimensionType.Overworld) offset = 4; // Adjust index for overworld

      // Get the subchunk from the chunk.
      const subchunk = chunk.getSubChunk(cy - offset);

      // Check if the subchunk is empty.
      if (!subchunk || subchunk.isEmpty()) continue;

      // Write the subchunk to the database.
      this.writeSubChunk(subchunk, chunk.x, cy - offset, chunk.z, dimension);
    }

    // Set the chunk as not dirty.
    chunk.dirty = false;
  }

  /**
   * Write the chunk version to the database.
   * @param cx The chunk X coordinate.
   * @param cz The chunk Z coordinate.
   * @param index The dimension index.
   * @param version The chunk version.
   */
  public writeChunkVersion(
    cx: number,
    cz: number,
    dimension: Dimension,
    version: number
  ): void {
    // Create a key for the chunk version
    const key = LevelDBProvider.buildChunkVersionKey(
      cx,
      cz,
      dimension.indexOf()
    );

    // Write the chunk version to the database.
    this.db.put(key, Buffer.from([version]));
  }

  /**
   * Checks if the database has a chunk.
   * @param cx The chunk X coordinate.
   * @param cz The chunk Z coordinate.
   * @param dimension The dimension to check for the chunk.
   */
  public hasChunk(cx: number, cz: number, dimension: Dimension): boolean {
    try {
      // Create a key for the chunk version.
      const key = LevelDBProvider.buildChunkVersionKey(
        cx,
        cz,
        dimension.indexOf()
      );

      // Check if the key exists in the database.
      const data = this.db.get(key);
      if (data) return true;

      // Return false if the chunk does not exist.
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Reads a subchunk from the database.
   * @param cx The chunk X coordinate.
   * @param cy The subchunk Y coordinate.
   * @param cz The chunk Z coordinate.
   * @param dimension The dimension to read the subchunk from.
   * @returns The subchunk from the database.
   */
  public readSubChunk(
    cx: number,
    cy: number,
    cz: number,
    dimension: Dimension
  ): SubChunk {
    // Attempt to read the subchunk from the database.
    try {
      // Build the subchunk key for the database.
      const key = LevelDBProvider.buildSubChunkKey(
        cx,
        cy,
        cz,
        dimension.indexOf()
      );

      // Deserialize the subchunk from the database.
      const subchunk = SubChunk.from(this.db.get(key), true);

      // Set the chunk y coordinate of the subchunk.
      subchunk.index = cy;

      // Return the subchunk from the database.
      return subchunk;
    } catch {
      // If an error occurs, return a new subchunk.
      // These means the subchunk does not exist.
      const subchunk = new SubChunk();

      // Set the chunk y coordinate of the subchunk.
      subchunk.index = cy;

      // Return the new subchunk.
      return subchunk;
    }
  }

  /**
   * Writes a subchunk to the database.
   * @param subchunk The subchunk to write.
   * @param cx The chunk X coordinate.
   * @param cy The subchunk Y coordinate.
   * @param cz The chunk Z coordinate.
   * @param dimension The dimension to write the subchunk to.
   */
  public writeSubChunk(
    subchunk: SubChunk,
    cx: number,
    cy: number,
    cz: number,
    dimension: Dimension
  ): void {
    // Create a key for the subchunk.
    const key = LevelDBProvider.buildSubChunkKey(
      cx,
      cy,
      cz,
      dimension.indexOf()
    );

    // Serialize the subchunk to a buffer
    const stream = new BinaryStream();
    SubChunk.serialize(subchunk, stream, true);

    // Write the subchunk to the database
    this.db.put(key, stream.getBuffer());
  }

  public readAvailableEntities(dimension: Dimension): Array<bigint> {
    // Prepare an array to store the entities unique identifiers.
    const uniqueIds = new Array<bigint>();

    // Attempt to read the entities from the database.
    try {
      // Create a key for the actor list.
      const key = LevelDBProvider.buildActorListKey(dimension);

      // Create a new BinaryStream instance.
      const stream = new BinaryStream(this.db.get(key));

      // Read the unique identifiers from the stream.
      do uniqueIds.push(stream.readInt64(Endianness.Little));
      while (!stream.cursorAtEnd());

      // Return the unique identifiers.
      return uniqueIds;
    } catch {
      // If an error occurs, return an empty array.
      return uniqueIds;
    }
  }

  public writeAvailableEntities(
    dimension: Dimension,
    entities: Array<bigint>
  ): void {
    // Create a key for the actor list.
    const key = LevelDBProvider.buildActorListKey(dimension);

    // Create a new BinaryStream instance.
    const stream = new BinaryStream();

    // Write the unique identifiers to the stream.
    for (const uniqueId of entities)
      stream.writeInt64(uniqueId, Endianness.Little);

    // Write the stream to the database.
    this.db.put(key, stream.getBuffer());
  }

  public readEntity(uniqueId: bigint, dimension: Dimension): EntityEntry {
    // Get all the available entities for the dimension.
    const entities = this.readAvailableEntities(dimension);

    // Check if the entity exists.
    if (!entities.includes(uniqueId)) {
      throw new Error(`Entity with unique id ${uniqueId} not found!`);
    }

    // Create a key for the entity.
    const key = LevelDBProvider.buildActorDataKey(uniqueId);

    // Read the entity data from the database.
    const buffer = this.db.get(key);

    // Parse the entity data from the buffer.
    const data = JSON.parse(buffer.toString(), (_, value) => {
      if (typeof value === "string" && value.endsWith("BigInt_t")) {
        return BigInt(value.slice(0, -8));
      }

      if (value === "Infinity_t") return Infinity;
      if (value === "-Infinity_t") return -Infinity;
      if (value === "NaN_t") return Number.NaN;

      return value;
    }) as EntityEntry;

    // Return the entity data.
    return data;
  }

  public writeEntity(entity: EntityEntry, dimension: Dimension): void {
    // Get all the available entities for the dimension.
    const entities = this.readAvailableEntities(dimension);

    // Check if the entity already exists.
    if (!entities.includes(BigInt(entity.uniqueId)))
      entities.push(BigInt(entity.uniqueId));

    // Write the entity to the database.
    const data = JSON.stringify(entity, (_, value) => {
      if (typeof value === "bigint") return value.toString() + "BigInt_t";
      if (value === Infinity) return "Infinity_t";
      if (value === -Infinity) return "-Infinity_t";
      if (Number.isNaN(value)) return "NaN_t";

      return value;
    });

    // Convert the entity data to a buffer.
    const buffer = Buffer.from(data);

    // Create a key for the entity.
    const key = LevelDBProvider.buildActorDataKey(BigInt(entity.uniqueId));

    // Write the entity data to the database.
    this.db.put(key, buffer);
  }

  public readPlayer(uuid: string, dimension: Dimension): PlayerEntry | null {
    // Attempt to read the player from the database.
    try {
      // Create a key for the player.
      const key = `player_server_${uuid}_${dimension.identifier}`;

      // Read the player data from the database.
      const buffer = this.db.get(Buffer.from(key));

      // Parse the player data from the buffer.
      const data = JSON.parse(buffer.toString(), (_, value) => {
        if (typeof value === "string" && value.endsWith("BigInt_t")) {
          return BigInt(value.slice(0, -8));
        }

        if (value === "Infinity_t") return Infinity;
        if (value === "-Infinity_t") return -Infinity;
        if (value === "NaN_t") return Number.NaN;

        return value;
      }) as PlayerEntry;

      // Return the player data.
      return data;
    } catch {
      return null;
    }
  }

  public writePlayer(player: PlayerEntry, dimension: Dimension): void {
    // We want to stringify the player data and write it to the database.
    // So we need a custom serialization method for bigints, as JSON.stringify does not support them.
    // Same goes for Infinity, -Infinity and NaN, but we don't have to worry about those here.
    const data = JSON.stringify(player, (_, value) => {
      if (typeof value === "bigint") return value.toString() + "BigInt_t";
      if (value === Infinity) return "Infinity_t";
      if (value === -Infinity) return "-Infinity_t";
      if (Number.isNaN(value)) return "NaN_t";

      return value;
    });

    // Convert the player data to a buffer.
    const buffer = Buffer.from(data);

    // Create a key for the player.
    const key = `player_server_${player.uuid}_${dimension.identifier}`;

    // Write the player data to the database.
    this.db.put(Buffer.from(key), buffer);
  }

  public readAvailableBlocks(dimension: Dimension): Array<BlockPosition> {
    // Prepare an array to store the block positions.
    const positions = new Array<BlockPosition>();

    // Attempt to read the blocks from the database.
    try {
      // Create a key for the block list.
      const key = LevelDBProvider.buildBlockDataListKey(dimension);

      // Create a new BinaryStream instance.
      const stream = new BinaryStream(this.db.get(key));

      // Read the block positions from the stream.
      do {
        // Read the block position from the stream.
        const position = BlockPosition.read(stream);

        // Add the block position to the array.
        positions.push(position);
      } while (!stream.cursorAtEnd());

      // Return the block positions;
      return positions;
    } catch {
      // If an error occurs, return an empty array.
      return positions;
    }
  }

  public writeAvailableBlocks(
    dimension: Dimension,
    positions: Array<BlockPosition>
  ): void {
    // Create a key for the block list.
    const key = LevelDBProvider.buildBlockDataListKey(dimension);

    // Create a new BinaryStream instance.
    const stream = new BinaryStream();

    // Write the block positions to the stream.
    for (const position of positions) BlockPosition.write(stream, position);

    // Write the stream to the database.
    this.db.put(key, stream.getBuffer());
  }

  public readBlock(position: BlockPosition, dimension: Dimension): BlockEntry {
    // Create a key for the block.
    const key = LevelDBProvider.buildBlockDataKey(
      position,
      dimension.indexOf()
    );

    // Read the block data from the database.
    const buffer = this.db.get(key);

    // Parse the block data from the buffer.
    const data = JSON.parse(buffer.toString()) as BlockEntry;

    // Return the block data.
    return data;
  }

  public writeBlock(block: BlockEntry, dimension: Dimension): void {
    // Create a block position instance.
    const position = new BlockPosition(...block.position);

    // Write the block to the database.
    const data = JSON.stringify(block);

    // Convert the block data to a buffer.
    const buffer = Buffer.from(data);

    // Create a key for the block.
    const key = LevelDBProvider.buildBlockDataKey(
      position,
      dimension.indexOf()
    );

    // Write the block data to the database.
    this.db.put(key, buffer);
  }

  public readProperty(key: Buffer): Buffer {
    return this.db.get(key);
  }

  public writeProperty(key: Buffer, value: Buffer): void {
    return this.db.put(key, value);
  }

  public static async initialize(
    serenity: Serenity,
    properties: WorldProviderProperties
  ): Promise<void> {
    // Resolve the path for the worlds directory.
    const path = resolve(properties.path);

    // Check if the path provided exists.
    // If it does not exist, create the directory.
    if (!existsSync(path)) mkdirSync(path);

    // Read all the directories in the world directory.
    // Excluding file types, as a world entry is a directory.
    const directories = readdirSync(path, { withFileTypes: true }).filter(
      (dirent) => dirent.isDirectory()
    );

    // Check if the directory is empty.
    // If it is, create a new world with the default identifier.
    if (directories.length === 0) {
      serenity.registerWorld(
        await this.create(serenity, properties, { identifier: "default" })
      );

      return;
    }

    // Iterate over the world entries in the directory.
    for (const directory of directories) {
      // Get the path for the world.
      const worldPath = resolve(path, directory.name);

      // Get the world properties.
      let properties: Partial<WorldProperties> = { identifier: directory.name };
      if (existsSync(resolve(worldPath, "properties.json"))) {
        // Read the properties of the world.
        properties = JSON.parse(
          readFileSync(resolve(worldPath, "properties.json"), "utf-8")
        );
      }

      // Check if the world directory contains a structures directory.
      if (!existsSync(resolve(worldPath, "structures")))
        // Create the structures directory if it does not exist.
        mkdirSync(resolve(worldPath, "structures"));

      // Create a new world instance.
      const world = new World(serenity, new this(worldPath), properties);

      // Create a new WorldInitializedSignal instance.
      new WorldInitializeSignal(world).emit();

      // Write the properties to the world.
      writeFileSync(
        resolve(worldPath, "properties.json"),
        JSON.stringify(world.properties, null, 2)
      );

      // Prepare the dimensions for the world.
      for (const dimension of world.dimensions.values()) {
        // Get the spawn position of the dimension.
        // const sx = dimension.properties.spawnPosition[0] >> 4;
        // const sz = dimension.properties.spawnPosition[2] >> 4;

        // Get the view distance of the dimension.
        const viewDistance = dimension.viewDistance;

        // Calculate the amount of chunks to pregenerate.
        const amount = (viewDistance * 2 + 1) ** 2;

        // Log the amount of chunks to pregenerate.
        world.logger.info(
          `Preparing §c${amount}§r chunks for dimension §a${dimension.identifier}§r.`
        );

        // Iterate over the chunks to pregenerate.
        // for (let x = -viewDistance; x <= viewDistance; x++) {
        //   for (let z = -viewDistance; z <= viewDistance; z++) {
        //     // Read the chunk from the provider.
        //     const chunk = await world.provider.readChunk(
        //       sx + x,
        //       sz + z,
        //       dimension
        //     );

        //     // Check if the chunk is ready.
        //     if (!chunk.ready) continue;

        //     // Serialize the chunk, the will cache the chunk in the provider.
        //     chunk.cache = Chunk.serialize(chunk);

        //     // Set the dirty flag to false.
        //     chunk.dirty = false;
        //   }
        // }

        // Log the success message.
        world.logger.success(
          `Successfully pre-generated §c${amount}§r chunks for for dimension §a${dimension.identifier}§r.`
        );
      }

      // Read all the structures in the world directory.
      const files = readdirSync(resolve(worldPath, "structures"), {
        withFileTypes: true
      }).filter(
        // Filter only files that end with .mcstructure.
        (dirent) => dirent.isFile() && dirent.name.endsWith(".mcstructure")
      );

      // Attempt to read the structures from the world directory.
      for (const file of files) {
        try {
          // Create the structure from the file.
          const path = resolve(worldPath, "structures", file.name);

          // Read the structure file.
          const stream = new BinaryStream(readFileSync(path));

          // Create a new structure instance from the file.
          const structure = Structure.from(world, CompoundTag.read(stream));

          // Parse the identifier from the file name.
          const identifier = file.name.replace(/\.mcstructure$/, "");

          // Add the structure to the world.
          world.structures.set(identifier, structure);

          // Log a debug message indicating the structure was loaded.
          world.logger.debug(
            `Loaded structure "${identifier}" from file "${file.name}" for world "${world.properties.identifier}."`
          );
        } catch (reason) {
          // Log the error if the structure failed to load.
          world.logger.error(
            `Failed to load structure from file ${file.name} for world ${world.properties.identifier}. Reason:`,
            reason
          );
        }
      }

      // Register the world with the serenity instance.
      serenity.registerWorld(world);
    }
  }

  public static async create(
    serenity: Serenity,
    properties: WorldProviderProperties,
    worldProperties?: Partial<WorldProperties>
  ): Promise<World> {
    // Resolve the path for the worlds directory.
    const path = resolve(properties.path);

    // Check if the path provided exists.
    // If it does not exist, create the directory.
    if (!existsSync(path)) mkdirSync(path);

    // Check if a world identifier was provided.
    if (!worldProperties?.identifier)
      throw new Error("A world identifier is required to create a new world.");

    // Get the world path from the properties.
    const worldPath = resolve(path, worldProperties.identifier);

    // Check if the world already exists.
    if (existsSync(worldPath))
      throw new Error(
        `World with identifier ${worldProperties.identifier} already exists in the directory.`
      );

    // Create the world directory.
    mkdirSync(worldPath);

    // Create a new world instance.
    const world = new World(serenity, new this(worldPath), worldProperties);

    // Assign the world to the provider.
    world.provider.world = world;

    // Create a new WorldInitializedSignal instance.
    new WorldInitializeSignal(world).emit();

    // Create the properties file for the world.
    writeFileSync(
      resolve(worldPath, "properties.json"),
      JSON.stringify(world.properties, null, 2)
    );

    // Prepare the dimensions for the world.
    for (const dimension of world.dimensions.values()) {
      // Get the spawn position of the dimension.
      // const sx = dimension.properties.spawnPosition[0] >> 4;
      // const sz = dimension.properties.spawnPosition[2] >> 4;

      // Get the view distance of the dimension.
      const viewDistance = dimension.viewDistance;

      // Calculate the amount of chunks to pregenerate.
      const amount = (viewDistance * 2 + 1) ** 2;

      // Log the amount of chunks to pregenerate.
      world.logger.info(
        `Preparing §c${amount}§r chunks for dimension §a${dimension.identifier}§r.`
      );

      // // Iterate over the chunks to pregenerate.
      // for (let x = -viewDistance; x <= viewDistance; x++) {
      //   for (let z = -viewDistance; z <= viewDistance; z++) {
      //     // Read the chunk from the provider.
      //     const chunk = await world.provider.readChunk(
      //       sx + x,
      //       sz + z,
      //       dimension
      //     );

      //     // Check if the chunk is ready.
      //     if (!chunk.ready) continue;

      //     // Serialize the chunk, the will cache the chunk in the provider.
      //     chunk.cache = Chunk.serialize(chunk);

      //     // Set the dirty flag to false.
      //     chunk.dirty = false;
      //   }
      // }

      // Log the success message.
      world.logger.success(
        `Successfully pre-generated §c${amount}§r chunks for for dimension §a${dimension.identifier}§r.`
      );
    }

    // Return the created world.
    return world;
  }

  /**
   * Build a subchunk key for the database.
   * @param cx The chunk X coordinate.
   * @param cy The subchunk Y coordinate.
   * @param cz The chunk Z coordinate.
   * @param index The dimension index.
   * @returns The buffer key for the subchunk
   */
  public static buildSubChunkKey(
    cx: number,
    cy: number,
    cz: number,
    index: number
  ): Buffer {
    // Create a new BinaryStream instance.
    const stream = new BinaryStream();

    // Write the chunk coordinates to the stream.
    stream.writeInt32(cx, Endianness.Little);
    stream.writeInt32(cz, Endianness.Little);

    // Check if the index is not 0.
    if (index !== 0) stream.writeInt32(index, Endianness.Little);

    // Write the query key to the stream.
    stream.writeByte(0x2f);

    // Write the subchunk index to the stream.
    stream.writeByte(cy);

    // Return the buffer from the stream.
    return stream.getBuffer();
  }

  /**
   * Build a chunk version key for the database.
   * @param cx The chunk X coordinate.
   * @param cz The chunk Z coordinate.
   * @param index The dimension index.
   * @returns The buffer key for the chunk version
   */
  public static buildChunkVersionKey(
    cx: number,
    cz: number,
    index: number
  ): Buffer {
    // Create a new BinaryStream instance.
    const stream = new BinaryStream();

    // Write the chunk coordinates to the stream.
    stream.writeInt32(cx, Endianness.Little);
    stream.writeInt32(cz, Endianness.Little);

    // Check if the index is not 0.
    if (index !== 0) {
      stream.writeInt32(index, Endianness.Little);
    }

    // Write the chunk version byte to the stream.
    stream.writeByte(0x2c);

    // Return the buffer from the stream
    return stream.getBuffer();
  }

  /**
   * Read the actor list key for the database.
   * @param dimension The dimension to read the actor list key for.
   * @returns The buffer key for the actor list
   */
  public static buildActorListKey(dimension: Dimension) {
    // Create a new BinaryStream instance.
    const stream = new BinaryStream();

    // Write the key symbol to the stream
    stream.writeInt32(0x64_69_67_70);

    // Check if the index is not 0.
    if (dimension.indexOf() !== 0)
      stream.writeInt32(dimension.indexOf(), Endianness.Little);

    // Return the buffer from the stream.
    return stream.getBuffer();
  }

  /**
   * Build an actor data key for the database.
   * @param uniqueId The unique identifier of the actor.
   * @returns The buffer key for the actor data
   */
  public static buildActorDataKey(uniqueId: bigint): Buffer {
    // Create a new BinaryStream instance.
    const stream = new BinaryStream();

    // Write the key symbol to the stream.
    stream.writeBuffer(Buffer.from("actorprefix", "ascii"));

    // Write the unique identifier to the stream.
    stream.writeInt64(uniqueId, Endianness.Little);

    // Return the buffer from the stream.
    return stream.getBuffer();
  }

  /**
   * Build a block key for the database.
   * @param position The block position.
   * @param index The dimension index.
   * @returns The buffer key for the block
   */
  public static buildBlockDataListKey(dimension: Dimension): Buffer {
    // Create a new BinaryStream instance.
    const stream = new BinaryStream();

    // Write the key symbol to the stream.
    stream.writeInt32(0x62_6c_6f_63_6b);

    // Check if the index is not 0.
    if (dimension.indexOf() !== 0)
      stream.writeInt32(dimension.indexOf(), Endianness.Little);

    // Return the buffer from the stream.
    return stream.getBuffer();
  }

  /**
   * Build a block key for the database.
   * @param position The block position.
   * @param index The dimension index.
   * @returns The buffer key for the block
   */
  public static buildBlockDataKey(
    position: BlockPosition,
    index: number
  ): Buffer {
    // Create a new BinaryStream instance.
    const stream = new BinaryStream();

    // Write the block position to the stream.
    stream.writeZigZag(position.x);
    stream.writeZigZag(position.y);
    stream.writeZigZag(position.z);

    // Check if the index is not 0.
    if (index !== 0) stream.writeInt32(index, Endianness.Little);

    // Write the key symbol to the stream.
    stream.writeByte(0x2d);

    // Return the buffer from the stream.
    return stream.getBuffer();
  }
}

export { LevelDBProvider };
