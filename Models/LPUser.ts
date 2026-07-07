import mongoose, { Schema, Document } from "mongoose";

export interface ILPUser extends Document {
  Nickname: string;
  UserId: string;
  DeviceIdentifier: string;
  DeviceName: string;
  DevicePlatform: Boolean;
  ClientToken: string;
  AccessToken: string;
  RefreshToken?: string;
  ExpireAt?: Date;
}

const UserCollection = new Schema<ILPUser>({
  Nickname: { type: String, required: true, unique: true },
  UserId: { type: String, required: true, unique: true },
  DeviceIdentifier: { type: String, required: true, unique: true },
  DeviceName: { type: String, required: true, unique: false },
  DevicePlatform: { type: Number, required: true, unique: false },
  ClientToken: { type: String, required: true, unique: false },
  AccessToken: { type: String, required: true, unique: true },
  RefreshToken: { type: String, required: false, unique: false },
  ExpireAt: { type: Date, required: false, unique: false },
});

UserCollection.index({ ClientToken: 1 });
UserCollection.index({ RefreshToken: 1 });
UserCollection.index({ ExpireAt: 1 });
UserCollection.index({ DeviceName: 1 });
UserCollection.index({ DevicePlatform: 1 });
export const LPUser = mongoose.model<ILPUser>("LPUser", UserCollection, "LP Users");
