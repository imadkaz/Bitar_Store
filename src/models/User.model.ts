export interface UserProps {
    id: bigint;
    email: string;
    passwordHash: string;
    fullName: string;
    isActive: boolean;
    deactivatedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    createdBy: bigint | null;
    updatedBy: bigint | null;
    version: number;
    creator?: UserProps | null;
    createdUsers?: UserProps[];
    updater?: UserProps | null;
    updatedUsers?: UserProps[];
}

export class User {
    private constructor(
        private readonly id: bigint,
        private  email: string,
        private  passwordHash: string,
        private  fullName: string,
        private  isActive: boolean,
        private  deactivatedAt: Date | null,
        private readonly createdAt: Date,
        private  updatedAt: Date,
        private  createdBy: bigint | null,
        private  updatedBy: bigint | null,
        private  version: number,
        private  creator?: UserProps | null,
        private  createdUsers?: UserProps[],
        private  updater?: UserProps | null,
        private  updatedUsers?: UserProps[]
    ){}
    static create(props: UserProps): User {
        const trimmedEmail = props.email.trim();
        const trimmedFullName = props.fullName.trim();
        if (trimmedEmail.length === 0) {
            throw new Error("Email cannot be empty");
        }
        if (trimmedFullName.length === 0) {
            throw new Error("Full name cannot be empty");
        }

        return new User(
            props.id,
            trimmedEmail,
            props.passwordHash,
            trimmedFullName,
            props.isActive,
            props.deactivatedAt,
            props.createdAt,
            props.updatedAt,
            props.createdBy,
            props.updatedBy,
            props.version,
            props.creator,
            props.createdUsers,
            props.updater,
            props.updatedUsers
        );
    }
    getId(): bigint {
        return this.id;
    }
    getEmail(): string {
        return this.email;
    }
    getPasswordHash(): string {
        return this.passwordHash;
    }
    getFullName(): string {
        return this.fullName;
    }

    getIsActive(): boolean {
        return this.isActive;
    }

    getDeactivatedAt(): Date | null {
        return this.deactivatedAt;
    }

    getCreatedAt(): Date {
        return this.createdAt;
    }

    getUpdatedAt(): Date {
        return this.updatedAt;
    }

    getCreatedBy(): bigint | null {
        return this.createdBy;
    }

    getUpdatedBy(): bigint | null {
        return this.updatedBy;
    }

    getVersion(): number {
        return this.version;
    }

    getCreator(): UserProps | null | undefined {
        return this.creator;
    }

    getCreatedUsers(): UserProps[] | undefined {
        return this.createdUsers;
    }

    getUpdater(): UserProps | null | undefined {
        return this.updater;
    }

    getUpdatedUsers(): UserProps[] | undefined {
        return this.updatedUsers;
    }
}